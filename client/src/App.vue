<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  api,
  ApiError,
  formatMoney,
  type Store,
  type Product,
  type Order,
} from "./api";
import { setupPayPal, type PaymentSession } from "./paypal";
import ProductArt from "./components/ProductArt.vue";

const store = ref<Store>();
const selected = ref<Product>();
const order = ref<Order>();
const celebration = ref<Order>();
const busy = ref(false);
const loading = ref(true);
const message = ref("");
const sdkError = ref("");
const sdkLoading = ref(false);
const paypalMount = ref<HTMLDivElement>();
let session: PaymentSession | undefined;
let pendingOrder: Promise<Order> | undefined;
let attempt:
  { requestId: string; productId: string; orderId?: string } | undefined;
const terminal = computed(
  () =>
    order.value &&
    ["CANCELLED", "DECLINED", "REVIEW"].includes(order.value.status),
);
const paymentUncertain = computed(
  () =>
    order.value?.captureAttempted &&
    !terminal.value &&
    order.value.status !== "COMPLETED",
);
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Checkout could not be completed. Please check your order.";
const statusText = computed(() => {
  switch (order.value?.status) {
    case "CANCELLED":
      return "Checkout cancelled. Your gift has not been unlocked.";
    case "DECLINED":
      return "Payment was declined. You can start again with a different Sandbox payment method.";
    case "PENDING":
      return "PayPal is still processing this payment. Your gift will unlock after confirmation.";
    case "REVIEW":
      return "The payment details need review. Keep this order reference and contact the project owner.";
    default:
      return paymentUncertain.value
        ? "Payment confirmation was interrupted. Check or retry this same order."
        : "";
  }
});
function persist() {
  // Only a local order identifier/request key; access is always checked with the HttpOnly session cookie.
  try {
    if (attempt)
      sessionStorage.setItem("delight-checkout", JSON.stringify(attempt));
  } catch {
    /* Cookie remains authoritative. */
  }
}
async function acceptOrder(value: Order) {
  order.value = value;
  if (attempt) {
    attempt.orderId = value.id;
    persist();
  }
  // Preserve SDK return parameters until hasReturned()/resume() have consumed them.
  const locationUrl = new URL(window.location.href);
  locationUrl.searchParams.set("order", value.id);
  history.replaceState(
    null,
    "",
    `${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`,
  );
  if (value.status === "COMPLETED") {
    const confirmed = await api<Order>(`/orders/${value.id}/gift`);
    if (confirmed.status !== "COMPLETED" || !confirmed.gift)
      throw new Error("A confirmed purchase is required.");
    celebration.value = confirmed;
    message.value = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}
async function confirmPayment(capture: boolean) {
  if (!order.value || busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    await acceptOrder(
      await api<Order>(
        `/orders/${order.value.id}/${capture ? "capture" : "reconcile"}`,
        {},
      ),
    );
  } catch (error) {
    message.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
async function onApprove(data: { orderId: string }) {
  busy.value = true;
  message.value = "";
  try {
    if (pendingOrder) await pendingOrder;
    if (!order.value || data.orderId !== order.value.paypalOrderId)
      throw new Error("The approved payment does not match this order.");
    await acceptOrder(
      await api<Order>(`/orders/${order.value.id}/capture`, {}),
    );
  } catch (error) {
    message.value = errorText(error);
    if (order.value) {
      try {
        order.value = await api<Order>(`/orders/${order.value.id}`);
      } catch {
        /* Retain the order for a retry. */
      }
    }
  } finally {
    busy.value = false;
  }
}
async function onCancel() {
  busy.value = true;
  try {
    if (pendingOrder) await pendingOrder;
    if (order.value)
      await acceptOrder(
        await api<Order>(`/orders/${order.value.id}/cancel`, {}),
      );
    if (!celebration.value)
      message.value =
        "Checkout was closed. You can return to your selection whenever you like.";
  } catch (error) {
    message.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
function resetPurchase(product = selected.value) {
  order.value = undefined;
  celebration.value = undefined;
  attempt = undefined;
  pendingOrder = undefined;
  selected.value = product;
  message.value = "";
  try {
    sessionStorage.removeItem("delight-checkout");
  } catch {
    /* Optional recovery storage. */
  }
  history.replaceState(null, "", "/");
  void renderPayPalButton();
}
function selectProduct(product: Product) {
  if (busy.value || paymentUncertain.value || (order.value && !terminal.value))
    return;
  resetPurchase(product);
  document
    .getElementById("checkout")
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}
async function ensureOrder(): Promise<Order> {
  if (!selected.value) throw new Error("Choose a product first.");
  if (order.value && !terminal.value) return order.value;
  if (terminal.value) {
    order.value = undefined;
    attempt = undefined;
  }
  if (!attempt)
    attempt = { requestId: crypto.randomUUID(), productId: selected.value.id };
  persist();
  const created = await api<Order>("/orders", {
    productId: attempt.productId,
    requestId: attempt.requestId,
  });
  await acceptOrder(created);
  return created;
}
async function startCheckout() {
  if (
    !session ||
    busy.value ||
    paymentUncertain.value ||
    order.value?.status === "REVIEW"
  )
    return;
  busy.value = true;
  message.value = "";
  pendingOrder = ensureOrder();
  // Pass the promise immediately to preserve the browser's popup activation.
  void pendingOrder.catch(() => undefined);
  try {
    await session.start(
      { presentationMode: "auto" },
      pendingOrder.then((value) => {
        if (!value.paypalOrderId || value.status === "COMPLETED")
          throw new Error("This order is already processed.");
        return { orderId: value.paypalOrderId };
      }),
    );
  } catch (error) {
    if (!celebration.value) message.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
async function renderPayPalButton() {
  await nextTick();
  if (!paypalMount.value) return;
  paypalMount.value.replaceChildren();
  if (!session) return;
  const button = document.createElement("paypal-button");
  button.setAttribute("aria-label", "Pay with PayPal Sandbox");
  if (busy.value) button.setAttribute("disabled", "");
  button.addEventListener("click", () => void startCheckout());
  paypalMount.value.append(button);
}
watch(busy, (value) =>
  paypalMount.value?.firstElementChild?.toggleAttribute("disabled", value),
);
watch([paymentUncertain, celebration], () => void renderPayPalButton());
async function initializePayPal() {
  if (!store.value?.checkout.clientId || sdkLoading.value) return;
  sdkLoading.value = true;
  sdkError.value = "";
  try {
    session = await setupPayPal(store.value.checkout.clientId, {
      onApprove,
      onCancel,
      onError: () => {
        if (!celebration.value)
          message.value =
            "PayPal checkout was interrupted. Check your order before trying again.";
        busy.value = false;
      },
    });
    if (session.hasReturned()) await session.resume();
    await renderPayPalButton();
  } catch (error) {
    sdkError.value = errorText(error);
  } finally {
    sdkLoading.value = false;
  }
}
async function loadStore() {
  loading.value = true;
  message.value = "";
  try {
    store.value = await api<Store>("/store");
    try {
      const saved = JSON.parse(
        sessionStorage.getItem("delight-checkout") ?? "null",
      );
      if (
        saved &&
        typeof saved.requestId === "string" &&
        typeof saved.productId === "string"
      )
        attempt = saved;
    } catch {
      /* Start without optional recovery metadata. */
    }
    selected.value =
      store.value.products.find(
        (product) => product.id === attempt?.productId,
      ) ?? store.value.products[0];
    const id =
      new URLSearchParams(location.search).get("order") ?? attempt?.orderId;
    if (id) {
      try {
        const saved = await api<Order>(`/orders/${encodeURIComponent(id)}`);
        selected.value =
          store.value.products.find(
            (product) => product.id === saved.product.id,
          ) ?? selected.value;
        await acceptOrder(saved);
        if (saved.captureAttempted && saved.status !== "COMPLETED")
          await confirmPayment(false);
      } catch (error) {
        message.value = errorText(error);
        if (
          error instanceof ApiError &&
          ["ORDER_NOT_FOUND", "INVALID_REQUEST", "SESSION_REQUIRED"].includes(
            error.code,
          )
        ) {
          attempt = undefined;
          try {
            sessionStorage.removeItem("delight-checkout");
          } catch {
            /* Optional. */
          }
        }
      }
    }
    await nextTick();
    if (store.value.checkout.enabled) await initializePayPal();
  } catch (error) {
    message.value = errorText(error);
  } finally {
    loading.value = false;
  }
}
onMounted(() => void loadStore());
</script>

<template>
  <div class="announcement">
    A little purchase. A personal surprise.
    <span>Welcome to the Sandbox store.</span>
  </div>
  <div class="page-shell">
    <header class="site-header">
      <a href="/" class="brand"
        ><span class="brand-mark">d.</span
        ><span>PayPal Delight <b>AI</b></span></a
      >
      <span class="sandbox-tag"
        ><span class="tiny-dot"></span> Sandbox only</span
      >
    </header>
    <main>
      <p v-if="message" class="notice" role="alert">{{ message }}</p>
      <section
        v-if="celebration"
        class="celebration"
        aria-labelledby="celebration-title"
      >
        <div class="success-icon" aria-hidden="true">✓</div>
        <p class="eyebrow">
          PAYMENT CONFIRMED · {{ formatMoney(celebration.amountMinor) }}
        </p>
        <h1 id="celebration-title">Celebrate Your<br /><em>Purchase!</em></h1>
        <p class="celebration-copy">
          Your <strong>{{ celebration.product.name }}</strong> is the beginning
          of something delightful.
        </p>
        <div class="gift-banner">
          <span aria-hidden="true">✦</span>
          <div>
            <strong
              >Your personal AI gift is
              {{
                celebration.gift?.status === "AVAILABLE"
                  ? "available"
                  : "reserved"
              }}.</strong
            >
            <p>One confirmed purchase. One gift made just for you.</p>
          </div>
        </div>
        <div class="gift-options">
          <button disabled>
            <span>01</span><strong>Caricature</strong
            ><small>You and your new favourite. Photo optional.</small>
          </button>
          <button disabled>
            <span>02</span><strong>Greeting Card</strong
            ><small>A little message with a lot of personality.</small>
          </button>
          <button disabled>
            <span>03</span><strong>Mini Comic</strong
            ><small>Your purchase, with a story of its own.</small>
          </button>
        </div>
        <p class="muted">
          Gift creation is coming in the next stage. Your purchase and gift
          entitlement are saved.
        </p>
        <details class="receipt">
          <summary>View purchase details</summary>
          <dl>
            <dt>Order</dt>
            <dd>{{ celebration.id }}</dd>
            <dt>PayPal Order</dt>
            <dd>{{ celebration.paypalOrderId }}</dd>
            <dt>Capture</dt>
            <dd>{{ celebration.captureId }}</dd>
            <dt>Total</dt>
            <dd>{{ formatMoney(celebration.amountMinor) }} EUR</dd>
          </dl>
        </details>
        <button class="text-button" @click="resetPurchase()">
          Back to the store <span aria-hidden="true">↗</span>
        </button>
      </section>
      <template v-else>
        <section class="hero">
          <div>
            <p class="eyebrow">THE LITTLE THINGS, MADE PERSONAL</p>
            <h1>Good finds.<br /><em>Even better feelings.</em></h1>
            <p class="hero-description">
              A few everyday favourites. An unexpected personal gift.<br
                class="desktop-break"
              />
              Pick something you love — we’ll add a little delight.
            </p>
            <a class="hero-link" href="#collection"
              >Explore the collection <span aria-hidden="true">↓</span></a
            >
          </div>
          <div
            class="hero-stamp"
            aria-label="One personal AI gift with every confirmed purchase"
          >
            <span class="stamp-star" aria-hidden="true">✳</span
            ><strong>A little extra,<br />just for you.</strong
            ><small>1 purchase = 1 AI gift</small>
          </div>
        </section>
        <section id="collection" aria-labelledby="collection-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">THE DELIGHT EDIT</p>
              <h2 id="collection-title">Three good reasons to smile.</h2>
            </div>
            <span class="collection-count">01 — 03 / THE ESSENTIALS</span>
          </div>
          <p v-if="loading && !store" role="status" class="loading">
            Opening the store…
          </p>
          <button
            v-if="!loading && !store"
            class="primary-button"
            @click="loadStore"
          >
            Try loading again
          </button>
          <div v-if="store" class="product-grid">
            <article
              v-for="(product, index) in store.products"
              :key="product.id"
              class="product-card"
              :class="{ selected: selected?.id === product.id }"
            >
              <div class="art-panel" :class="product.color">
                <span class="product-index">0{{ index + 1 }}</span
                ><span class="gift-pill">+ a personal AI gift</span
                ><ProductArt :kind="product.art" />
              </div>
              <div class="product-heading">
                <h3>{{ product.name }}</h3>
                <span class="price">{{
                  formatMoney(product.amountMinor, product.currency)
                }}</span>
              </div>
              <p class="product-description">{{ product.description }}</p>
              <button
                class="choose-button"
                :class="{ chosen: selected?.id === product.id }"
                :disabled="
                  busy ||
                  Boolean(paymentUncertain) ||
                  Boolean(order && !terminal)
                "
                @click="selectProduct(product)"
              >
                {{
                  selected?.id === product.id
                    ? "Selected for you"
                    : "Choose this one"
                }}
                <span aria-hidden="true">{{
                  selected?.id === product.id ? "✓" : "↗"
                }}</span>
              </button>
            </article>
          </div>
        </section>
        <section
          v-if="selected && store"
          id="checkout"
          class="checkout"
          aria-labelledby="checkout-title"
          :aria-busy="busy"
        >
          <div class="checkout-summary">
            <p class="eyebrow">YOUR LITTLE MOMENT OF DELIGHT</p>
            <h2 id="checkout-title">Make it yours.</h2>
            <div class="checkout-item">
              <div class="mini-art" :class="selected.color">
                <ProductArt :kind="selected.art" />
              </div>
              <div>
                <strong>{{ selected.name }}</strong>
                <p>Quantity 1 · Includes one personal AI gift</p>
              </div>
              <strong class="checkout-price">{{
                formatMoney(selected.amountMinor)
              }}</strong>
            </div>
            <div class="checkout-total">
              <span>Total <small>(EUR)</small></span
              ><strong>{{ formatMoney(selected.amountMinor) }}</strong>
            </div>
            <p class="demo-note">
              Demo products, test funds. Nothing is shipped and no real money is
              charged.
            </p>
          </div>
          <div class="payment-panel">
            <p class="eyebrow">A SAFE LITTLE CHECKOUT</p>
            <h3>Pay with PayPal</h3>
            <p>
              Use your Sandbox Personal account. Your gift unlocks after payment
              is confirmed.
            </p>
            <p v-if="statusText" class="payment-status" role="status">
              {{ statusText }}
            </p>
            <p v-if="!store.checkout.enabled" class="payment-status">
              Sandbox checkout is being set up. Come back soon to try a
              purchase.
            </p>
            <template v-else>
              <p v-if="sdkLoading" role="status">Preparing secure checkout…</p>
              <div v-if="sdkError" class="sdk-error" role="alert">
                <p>{{ sdkError }}</p>
                <button
                  class="text-button"
                  :disabled="sdkLoading"
                  @click="initializePayPal"
                >
                  Reload PayPal
                </button>
              </div>
              <div
                v-show="!paymentUncertain && order?.status !== 'REVIEW'"
                ref="paypalMount"
                class="paypal-mount"
              ></div>
              <p v-if="busy" role="status" class="processing">
                Checking with PayPal… Please keep this page open.
              </p>
              <div v-if="order && !terminal" class="recovery-actions">
                <button
                  class="text-button"
                  :disabled="busy"
                  @click="confirmPayment(false)"
                >
                  Check payment status</button
                ><button
                  v-if="paymentUncertain && order.status !== 'PENDING'"
                  class="text-button"
                  :disabled="busy"
                  @click="confirmPayment(true)"
                >
                  Retry confirmation</button
                ><button
                  v-if="!order.captureAttempted"
                  class="text-button"
                  :disabled="busy"
                  @click="onCancel"
                >
                  Cancel this checkout
                </button>
              </div>
            </template>
            <p class="secure-note">
              <span aria-hidden="true">◇</span> Secure PayPal checkout · Sandbox
              environment
            </p>
            <p v-if="order" class="order-reference">
              Order reference: {{ order.id }}
            </p>
          </div>
        </section>
        <section class="how-it-works" aria-label="How your gift works">
          <div>
            <span>01</span>
            <h3>Find your favourite</h3>
            <p>Choose a little something from our edit.</p>
          </div>
          <div>
            <span>02</span>
            <h3>Make it official</h3>
            <p>Complete a test purchase with PayPal.</p>
          </div>
          <div>
            <span>03</span>
            <h3>Add your personality</h3>
            <p>Your personal AI gift is next. Coming soon.</p>
          </div>
        </section>
      </template>
    </main>
    <footer>
      <span class="footer-brand">A little more delight.</span
      ><span>PayPal Delight AI · Hackathon 2026</span
      ><span>Made for a smile <span aria-hidden="true">✳</span></span>
    </footer>
  </div>
</template>
