<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from 'vue-i18n';
import { errorKey, setLocale, type Locale } from './i18n';
import LegalPage from './components/LegalPage.vue';
import GiftFlow from './components/GiftFlow.vue';
import {
  api,
  ApiError,
  formatMoney as formatValue,
  type Store,
  type Product,
  type Order,
} from "./api";
import { setupPayPal, type PaymentSession } from "./paypal";
import ProductArt from "./components/ProductArt.vue";

const { t, locale } = useI18n();
const legalPage = location.pathname === '/legal' ? 'legal' : location.pathname === '/privacy' ? 'privacy' : null;
const formatMoney = (minor: number, currency = 'EUR') => formatValue(minor, currency, locale.value);
function productName(product: { id: string; name: string }) {
  const catalog = store.value?.products.find(item => item.id === product.id);
  return locale.value === 'de' ? catalog?.translations.de.name ?? product.name : product.name;
}
function productDescription(product: Product) {
  return locale.value === 'de' ? product.translations.de.description : product.description;
}
const store = ref<Store>();
const selected = ref<Product>();
const order = ref<Order>();
const celebration = ref<Order>();
const purchases = ref<Order[]>([]);
const purchasesError = ref('');
const lastGiftOrder = computed(() => purchases.value[0]?.id);
let giftViewRevision = 0;
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
const errorText = errorKey;
const statusText = computed(() => {
  switch (order.value?.status) {
    case "CANCELLED":
      return t('status.CANCELLED');
    case "DECLINED":
      return t('status.DECLINED');
    case "PENDING":
      return t('status.PENDING');
    case "REVIEW":
      return t('status.REVIEW');
    default:
      return paymentUncertain.value
        ? t('status.uncertain')
        : "";
  }
});
function persist() {
  // Only a local order identifier/request key; access is always checked with the HttpOnly session cookie.
  try {
    if (attempt)
      sessionStorage.setItem("delight-checkout", JSON.stringify(attempt));
    else sessionStorage.removeItem('delight-checkout');
  } catch {
    /* Cookie remains authoritative. */
  }
}
async function loadPurchases() {
  try {
    purchases.value = await api<Order[]>('/orders');
    purchasesError.value = '';
  } catch { purchasesError.value = 'gift.historyError'; }
}
function rememberPurchase(value: Order) {
  const index = purchases.value.findIndex(item => item.id === value.id);
  if (index < 0) purchases.value.unshift(value);
  else purchases.value[index] = value;
}
async function showGift(value: Order) {
  const revision = ++giftViewRevision;
  const confirmed = await api<Order>(`/orders/${value.id}/gift`);
  if (revision !== giftViewRevision) return;
  if (confirmed.id !== value.id || confirmed.status !== 'COMPLETED' || !confirmed.gift)
    throw new ApiError('PAYMENT_REQUIRED', '');
  celebration.value = confirmed;
  rememberPurchase(confirmed);
  message.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function updateGift(value: Order) {
  // A delayed reply from an unmounted gift form must never replace another purchase.
  if (celebration.value?.id !== value.id) return;
  celebration.value = value;
  if (order.value?.id === value.id) order.value = value;
  rememberPurchase(value);
}
async function acceptOrder(value: Order) {
  order.value = value;
  // Preserve SDK return parameters until hasReturned()/resume() have consumed them.
  const locationUrl = new URL(window.location.href);
  locationUrl.searchParams.set("order", value.id);
  history.replaceState(
    null,
    "",
    `${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`,
  );
  if (value.status === "COMPLETED") {
    if (attempt?.orderId === value.id) { attempt = undefined; persist(); }
    rememberPurchase(value);
    await showGift(value);
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
      throw new ApiError('APPROVED_ORDER_MISMATCH', '');
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
        'checkout.closed';
  } catch (error) {
    message.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
function resetPurchase(product = selected.value) {
  giftViewRevision++;
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
function returnToStore() {
  // Viewing an earlier gift must preserve recovery of a different unfinished purchase.
  if (attempt && attempt.orderId !== celebration.value?.id) window.location.assign('/');
  else resetPurchase();
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
  if (!selected.value) throw new ApiError('INVALID_PRODUCT', '');
  if (order.value && order.value.status !== 'COMPLETED' && !terminal.value) return order.value;
  if (terminal.value || order.value?.status === 'COMPLETED') {
    order.value = undefined;
    attempt = undefined;
  }
  if (!attempt)
    attempt = { requestId: crypto.randomUUID(), productId: selected.value.id };
  const currentAttempt = attempt;
  persist();
  const created = await api<Order>("/orders", {
    productId: currentAttempt.productId,
    requestId: currentAttempt.requestId,
  });
  if (attempt !== currentAttempt) throw new ApiError('ORDER_PROCESSED', '');
  // Bind the recovery key only to the response of its own create request.
  currentAttempt.orderId = created.id;
  persist();
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
          throw new ApiError('ORDER_PROCESSED', '');
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
  button.setAttribute("aria-label", t('checkout.button'));
  if (busy.value) button.setAttribute("disabled", "");
  button.addEventListener("click", () => void startCheckout());
  paypalMount.value.append(button);
}
watch(busy, (value) =>
  paypalMount.value?.firstElementChild?.toggleAttribute("disabled", value),
);
watch([paymentUncertain, celebration], () => void renderPayPalButton());
watch(locale, () => paypalMount.value?.firstElementChild?.setAttribute('aria-label', t('checkout.button')));
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
            'checkout.interrupted';
        busy.value = false;
      },
    }, locale.value);
    if (!celebration.value && session.hasReturned()) await session.resume();
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
    await loadPurchases();
    try {
      sessionStorage.removeItem('delight-last-gift-order');
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
    const requestedId = new URLSearchParams(location.search).get('order');
    const id = requestedId ?? attempt?.orderId;
    if (id) {
      try {
        const saved = await api<Order>(`/orders/${encodeURIComponent(id)}`);
        selected.value =
          store.value.products.find(
            (product) => product.id === saved.product.id,
          ) ?? selected.value;
        if (saved.status === 'COMPLETED') {
          // Completed purchases belong to history, never to a reusable checkout attempt.
          if (attempt?.orderId === saved.id) { attempt = undefined; persist(); }
          if (requestedId) await showGift(saved);
        } else {
          await acceptOrder(saved);
          if (saved.captureAttempted) await confirmPayment(false);
        }
      } catch (error) {
        message.value = errorText(error);
        if (
          error instanceof ApiError &&
          ["ORDER_NOT_FOUND", "INVALID_REQUEST", "SESSION_REQUIRED"].includes(
            error.code,
          )
        ) {
          if (attempt?.orderId === id) { attempt = undefined; persist(); }
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
onMounted(() => { if (!legalPage) void loadStore(); });
</script>

<template>
  <div class="announcement">
    {{ t('announcement.title') }}
    <span>{{ t('announcement.welcome') }}</span>
  </div>
  <div class="page-shell">
    <header class="site-header">
      <a href="/" class="brand"
        ><span class="brand-mark">d.</span
        ><span>PayPal Delight <b>AI</b></span></a
      >
      <div class="header-actions">
        <span class="sandbox-tag"><span class="tiny-dot"></span>{{ t('common.sandbox') }}</span>
        <label class="language-switch">{{ t('common.language') }}
          <select :value="locale" @change="setLocale(($event.target as HTMLSelectElement).value as Locale)" data-testid="language-switch">
            <option value="de">DE</option><option value="en">EN</option>
          </select>
        </label>
      </div>
    </header>
    <LegalPage v-if="legalPage" :kind="legalPage" />
    <main v-else>
      <p v-if="message" class="notice" role="alert">{{ t(message) }}</p>
      <section
        v-if="celebration"
        class="celebration"
        aria-labelledby="celebration-title"
      >
        <div class="success-icon" aria-hidden="true">✓</div>
        <p class="eyebrow">
          {{ t('celebrate.confirmed') }} · {{ formatMoney(celebration.amountMinor) }}
        </p>
        <h1 id="celebration-title">{{ t('celebrate.title') }}<br /><em>{{ t('celebrate.accent') }}</em></h1>
        <p class="celebration-copy">
          {{ t('celebrate.product', { product: productName(celebration.product) }) }}
        </p>
        <div class="gift-banner">
          <span aria-hidden="true">✦</span>
          <div>
            <strong>{{ t(celebration.gift?.status === 'AVAILABLE' ? 'celebrate.available' : celebration.gift?.status === 'COMPLETED' ? 'celebrate.generated' : 'celebrate.reserved') }}</strong>
            <p>{{ t('celebrate.one') }}</p>
          </div>
        </div>
        <GiftFlow :key="celebration.id" :order="celebration" :product-name="productName(celebration.product)" :is-demo="store?.gifts.isDemo ?? true" @update="updateGift" />
        <details class="receipt">
          <summary>{{ t('celebrate.receipt') }}</summary>
          <dl>
            <dt>{{ t('celebrate.order') }}</dt>
            <dd>{{ celebration.id }}</dd>
            <dt>{{ t('celebrate.paypalOrder') }}</dt>
            <dd>{{ celebration.paypalOrderId }}</dd>
            <dt>{{ t('celebrate.capture') }}</dt>
            <dd>{{ celebration.captureId }}</dd>
            <dt>{{ t('common.total') }}</dt>
            <dd>{{ formatMoney(celebration.amountMinor) }} EUR</dd>
          </dl>
        </details>
        <button class="text-button" @click="returnToStore">
          {{ t('common.back') }} <span aria-hidden="true">↗</span>
        </button>
      </section>
      <template v-else>
        <a v-if="lastGiftOrder" :href="`/?order=${lastGiftOrder}`" class="return-gift">{{ t('gift.return') }} ↗</a>
        <details v-if="purchases.length || purchasesError" class="purchase-history" data-testid="purchase-history">
          <summary>{{ t('gift.history') }} <span v-if="purchases.length">({{ purchases.length }})</span></summary>
          <p class="muted">{{ t('gift.historyHint') }}</p>
          <p v-if="purchasesError" role="alert">{{ t(purchasesError) }} <button class="text-button" @click="loadPurchases">{{ t('store.retry') }}</button></p>
          <ul>
            <li v-for="purchase in purchases" :key="purchase.id">
              <a :href="`/?order=${purchase.id}`" :data-testid="`purchase-${purchase.id}`">
                <strong>{{ productName(purchase.product) }}</strong>
                <span>{{ purchase.gift?.status === 'COMPLETED' ? t('gift.historyReady') : purchase.gift?.status === 'GENERATING' ? t('gift.generating') : t('gift.historyAvailable') }}</span>
                <small>{{ t('celebrate.order') }} {{ purchase.id.slice(0, 8) }} · {{ formatMoney(purchase.amountMinor, purchase.currency) }}<template v-if="purchase.gift?.result"> · {{ t(purchase.gift.result.type === 'caricature' ? 'gift.caricature' : purchase.gift.result.type === 'greeting-card' ? 'gift.greeting' : 'gift.comic') }}</template></small>
              </a>
            </li>
          </ul>
        </details>
        <section class="hero">
          <div>
            <p class="eyebrow">{{ t('hero.eyebrow') }}</p>
            <h1>{{ t('hero.title') }}<br /><em>{{ t('hero.accent') }}</em></h1>
            <p class="hero-description">
              {{ t('hero.description') }}<br
                class="desktop-break"
              />
              {{ t('hero.invitation') }}
            </p>
            <a class="hero-link" href="#collection"
              >{{ t('hero.explore') }} <span aria-hidden="true">↓</span></a
            >
          </div>
          <div
            class="hero-stamp"
            :aria-label="t('hero.stampLabel')"
          >
            <span class="stamp-star" aria-hidden="true">✳</span
            ><strong>{{ t('hero.stamp') }}<br />{{ t('hero.stampAccent') }}</strong
            ><small>{{ t('hero.equation') }}</small>
          </div>
        </section>
        <section id="collection" aria-labelledby="collection-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">{{ t('store.eyebrow') }}</p>
              <h2 id="collection-title">{{ t('store.title') }}</h2>
            </div>
            <span class="collection-count">{{ t('store.count') }}</span>
          </div>
          <p v-if="loading && !store" role="status" class="loading">
            {{ t('store.loading') }}
          </p>
          <button
            v-if="!loading && !store"
            class="primary-button"
            @click="loadStore"
          >
            {{ t('store.retry') }}
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
                ><span class="gift-pill">{{ t('store.gift') }}</span
                ><ProductArt :kind="product.art" />
              </div>
              <div class="product-heading">
                <h3>{{ productName(product) }}</h3>
                <span class="price">{{
                  formatMoney(product.amountMinor, product.currency)
                }}</span>
              </div>
              <p class="product-description">{{ productDescription(product) }}</p>
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
                    ? t('store.selected')
                    : t('store.choose')
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
            <p class="eyebrow">{{ t('checkout.eyebrow') }}</p>
            <h2 id="checkout-title">{{ t('checkout.title') }}</h2>
            <div class="checkout-item">
              <div class="mini-art" :class="selected.color">
                <ProductArt :kind="selected.art" />
              </div>
              <div>
                <strong>{{ productName(selected) }}</strong>
                <p>{{ t('checkout.quantity') }}</p>
              </div>
              <strong class="checkout-price">{{
                formatMoney(selected.amountMinor)
              }}</strong>
            </div>
            <div class="checkout-total">
              <span>{{ t('common.total') }} <small>(EUR)</small></span
              ><strong>{{ formatMoney(selected.amountMinor) }}</strong>
            </div>
            <p class="demo-note">
              {{ t('checkout.demo') }}
            </p>
          </div>
          <div class="payment-panel">
            <p class="eyebrow">{{ t('checkout.safe') }}</p>
            <h3>{{ t('checkout.pay') }}</h3>
            <p>
              {{ t('checkout.account') }}
            </p>
            <p v-if="statusText" class="payment-status" role="status">
              {{ statusText }}
            </p>
            <p v-if="!store.checkout.enabled" class="payment-status">
              {{ t('checkout.unavailable') }}
            </p>
            <template v-else>
              <p v-if="sdkLoading" role="status">{{ t('checkout.preparing') }}</p>
              <div v-if="sdkError" class="sdk-error" role="alert">
                <p>{{ t(sdkError) }}</p>
                <button
                  class="text-button"
                  :disabled="sdkLoading"
                  @click="initializePayPal"
                >
                  {{ t('checkout.reload') }}
                </button>
              </div>
              <div
                v-show="!paymentUncertain && order?.status !== 'REVIEW'"
                ref="paypalMount"
                class="paypal-mount"
              ></div>
              <p v-if="busy" role="status" class="processing">
                {{ t('checkout.processing') }}
              </p>
              <div v-if="order && !terminal" class="recovery-actions">
                <button
                  class="text-button"
                  :disabled="busy"
                  @click="confirmPayment(false)"
                >
                  {{ t('checkout.check') }}</button
                ><button
                  v-if="paymentUncertain && order.status !== 'PENDING'"
                  class="text-button"
                  :disabled="busy"
                  @click="confirmPayment(true)"
                >
                  {{ t('checkout.retry') }}</button
                ><button
                  v-if="!order.captureAttempted"
                  class="text-button"
                  :disabled="busy"
                  @click="onCancel"
                >
                  {{ t('checkout.cancel') }}
                </button>
              </div>
            </template>
            <p class="secure-note">
              <span aria-hidden="true">◇</span> {{ t('checkout.secure') }}
            </p>
            <p v-if="order" class="order-reference">
              {{ t('checkout.reference', { id: order.id }) }}
            </p>
          </div>
        </section>
        <section class="how-it-works" :aria-label="t('steps.label')">
          <div>
            <span>01</span>
            <h3>{{ t('steps.first') }}</h3>
            <p>{{ t('steps.firstText') }}</p>
          </div>
          <div>
            <span>02</span>
            <h3>{{ t('steps.second') }}</h3>
            <p>{{ t('steps.secondText') }}</p>
          </div>
          <div>
            <span>03</span>
            <h3>{{ t('steps.third') }}</h3>
            <p>{{ t('steps.thirdText') }}</p>
          </div>
        </section>
      </template>
    </main>
    <footer>
      <span class="footer-brand">{{ t('footer.brand') }}</span
      ><span>PayPal Delight AI · Hackathon 2026</span
      ><nav class="legal-links"><a href="/legal">{{ t('footer.legal') }}</a><a href="/privacy">{{ t('footer.privacy') }}</a></nav>
      <span>{{ t('footer.smile') }} <span aria-hidden="true">✳</span></span>
    </footer>
  </div>
</template>
