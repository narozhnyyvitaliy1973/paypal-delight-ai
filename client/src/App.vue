<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from 'vue-i18n';
import { errorKey, setLocale, type Locale } from './i18n';
import LegalPage from './components/LegalPage.vue';
import GiftFlow from './components/GiftFlow.vue';
import AiLab from './components/AiLab.vue';
import {
  api,
  ApiError,
  formatMoney as formatValue,
  type Store,
  type Product,
  type Order,
  type GiftView,
} from "./api";
import { setupPayPal, type PaymentSession } from "./paypal";
import ProductPhoto from './components/ProductPhoto.vue';
import AppIcon from './components/AppIcon.vue';

const { t, locale } = useI18n();
const labPage = location.pathname === '/ai-lab';
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
function revealPurchases() {
  const panel = document.getElementById('purchases') as HTMLDetailsElement | null;
  if (panel) panel.open = true;
}
const scrollBehavior = (): ScrollBehavior => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
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
  window.scrollTo({ top: 0, behavior: scrollBehavior() });
}
function updateGift(value: GiftView) {
  // A delayed reply from an unmounted gift form must never replace another purchase.
  if (celebration.value?.id !== value.id) return;
  const updated = { ...celebration.value, gift: value.gift };
  celebration.value = updated;
  if (order.value?.id === value.id) order.value = updated;
  rememberPurchase(updated);
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
    ?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
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
onMounted(async () => {
  if (!legalPage && !labPage) {
    await loadStore();
    await nextTick();
    if (location.hash === '#purchases') revealPurchases();
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: scrollBehavior() });
  }
});
</script>

<template>
  <a class="skip-link" href="#main-content">{{ t('design.skip') }}</a>
  <div class="page-shell">
    <header class="site-header">
      <a href="/" class="brand"><span class="brand-mark"><AppIcon /></span><span>Museum Puzzles</span></a>
      <nav class="main-nav" :aria-label="t('design.navigation')">
        <a :href="celebration || legalPage || labPage ? '/#collection' : '#collection'">{{ t('design.collection') }}</a>
        <a :href="celebration || legalPage || labPage ? '/#how-it-works' : '#how-it-works'">{{ t('design.how') }}</a>
        <a v-if="purchases.length || purchasesError" :href="celebration ? '/#purchases' : '#purchases'" @click="revealPurchases"><AppIcon name="bag" />{{ t('design.purchases') }}<span class="nav-count">{{ purchases.length }}</span></a>
        <a v-if="store?.labAvailable || labPage" href="/ai-lab">{{ t('lab.title') }}</a>
      </nav>
      <div class="header-actions"><span class="sandbox-tag">{{ t('common.sandbox') }}</span><label class="language-switch"><span class="sr-only">{{ t('common.language') }}</span><select :value="locale" @change="setLocale(($event.target as HTMLSelectElement).value as Locale)" data-testid="language-switch"><option value="de">DE</option><option value="en">EN</option></select></label></div>
    </header>
    <LegalPage v-if="legalPage" :kind="legalPage" id="main-content" />
    <AiLab v-else-if="labPage" id="main-content" @configuration="store = $event" />
    <main v-else id="main-content" tabindex="-1">
      <p v-if="message" class="notice" role="alert">{{ t(message) }}</p>
      <section v-if="celebration" class="celebration" :class="{ 'has-result': celebration.gift?.result }" aria-labelledby="celebration-title">
        <div class="celebration-heading">
          <div class="celebrate-confetti" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <div class="success-icon" aria-hidden="true"><AppIcon name="check" /></div>
          <h1 id="celebration-title">{{ t('design.paymentSuccess') }}</h1>
          <p class="celebration-copy">{{ t('celebrate.product', { product: productName(celebration.product) }) }}</p>
        </div>
        <div class="purchase-context">
          <div class="context-product"><ProductPhoto :id="celebration.product.id" eager /><div><span class="eyebrow">{{ t('design.purchaseContext') }}</span><strong>{{ productName(celebration.product) }}</strong></div><span class="context-price">{{ formatMoney(celebration.amountMinor) }}</span></div>
          <div class="gift-banner"><span class="context-gift-icon"><AppIcon name="gift" /></span><div><strong>{{ t(celebration.gift?.status === 'AVAILABLE' ? 'celebrate.available' : celebration.gift?.status === 'COMPLETED' ? 'celebrate.generated' : 'celebrate.reserved') }}</strong><p>{{ t('celebrate.one') }}</p></div></div>
        </div>
        <GiftFlow :key="celebration.id" :order="celebration" :product-name="productName(celebration.product)" :is-demo="store?.gifts.isDemo ?? true" :provider="store?.gifts.provider" :ai-enabled="store?.gifts.enabled" @update="updateGift" />
        <div class="purchase-actions">
          <details class="receipt"><summary>{{ t('celebrate.receipt') }}</summary><dl><dt>{{ t('celebrate.order') }}</dt><dd>{{ celebration.id }}</dd><dt>{{ t('celebrate.paypalOrder') }}</dt><dd>{{ celebration.paypalOrderId }}</dd><dt>{{ t('celebrate.capture') }}</dt><dd>{{ celebration.captureId }}</dd><dt>{{ t('common.total') }}</dt><dd>{{ formatMoney(celebration.amountMinor) }} EUR</dd></dl></details>
          <button class="text-button" @click="returnToStore">{{ t('common.back') }}<AppIcon name="arrow" /></button>
        </div>
      </section>
      <template v-else>
        <div v-if="lastGiftOrder" class="return-gift"><AppIcon name="gift" /><a :href="`/?order=${lastGiftOrder}`">{{ t('gift.return') }} <span aria-hidden="true">↗</span></a></div>
        <details v-if="purchases.length || purchasesError" id="purchases" class="purchase-history" data-testid="purchase-history">
          <summary>{{ t('gift.history') }} <span v-if="purchases.length">({{ purchases.length }})</span></summary>
          <p class="muted">{{ t('gift.historyHint') }}</p>
          <p v-if="purchasesError" role="alert">{{ t(purchasesError) }} <button class="text-button" @click="loadPurchases">{{ t('store.retry') }}</button></p>
          <ul><li v-for="purchase in purchases" :key="purchase.id"><a :href="`/?order=${purchase.id}`" :data-testid="`purchase-${purchase.id}`"><ProductPhoto :id="purchase.product.id" /><div><strong>{{ productName(purchase.product) }}</strong><span>{{ purchase.gift?.status === 'COMPLETED' ? t('gift.historyReady') : purchase.gift?.status === 'GENERATING' ? t('gift.generating') : purchase.gift?.status === 'REVIEW' ? t('gift.reviewTitle') : t('gift.historyAvailable') }}</span><small>{{ t('celebrate.order') }} {{ purchase.id.slice(0, 8) }} · {{ formatMoney(purchase.amountMinor, purchase.currency) }}<template v-if="purchase.gift?.result"> · {{ t(purchase.gift.result.type === 'caricature' ? 'gift.caricature' : purchase.gift.result.type === 'greeting-card' ? 'gift.greeting' : 'gift.comic') }}</template></small></div><AppIcon name="arrow" /></a></li></ul>
        </details>
        <section class="hero">
          <div class="hero-photo" aria-hidden="true"><ProductPhoto kind="starry-night" eager /></div>
          <div class="hero-copy">
            <h1>{{ t('design.heroTitle') }} <em>{{ t('design.heroAccent') }}</em></h1>
            <p class="hero-description">{{ t('design.heroDescription') }}</p>
            <div class="hero-benefits"><span><AppIcon name="shield" />{{ t('design.heroBenefitPay') }}</span><span><AppIcon name="gift" />{{ t('design.heroBenefitGift') }}</span><span><AppIcon name="spark" />{{ t('design.heroBenefitSmile') }}</span></div>
            <p class="hero-demo">{{ t(store?.gifts.isDemo === false ? 'gift.aiShort' : 'design.demoShort') }}</p>
          </div>
          <div class="hero-gift-badge"><AppIcon name="gift" /><div><strong>{{ t('design.included') }}</strong><span>{{ t('design.afterCheckout') }}</span></div></div>
        </section>
        <section id="collection" aria-labelledby="collection-title">
          <div class="section-heading"><h2 id="collection-title">{{ t('design.favourites') }}</h2><span class="collection-count">{{ t('store.count') }}</span></div>
          <p v-if="loading && !store" role="status" class="loading">{{ t('store.loading') }}</p><button v-if="!loading && !store" class="primary-button" @click="loadStore">{{ t('store.retry') }}</button>
          <div v-if="store" class="product-grid"><article v-for="(product, index) in store.products" :key="product.id" class="product-card" :class="{ selected: selected?.id === product.id }">
            <div class="art-panel" :class="product.color"><span class="product-index">0{{ index + 1 }}</span><span class="gift-pill"><AppIcon name="gift" />{{ t('design.included') }}</span><ProductPhoto :kind="product.art" :alt="productName(product)" /></div>
            <div class="product-body"><p class="product-category eyebrow">{{ t(`design.categories.${product.art}`) }}</p><div class="product-heading"><h3>{{ productName(product) }}</h3><span class="price">{{ formatMoney(product.amountMinor, product.currency) }}</span></div><p class="product-description">{{ productDescription(product) }}</p><button class="choose-button" :class="{ chosen: selected?.id === product.id }" :disabled="busy || Boolean(paymentUncertain) || Boolean(order && !terminal)" @click="selectProduct(product)">{{ selected?.id === product.id ? t('store.selected') : t('store.choose') }}<AppIcon :name="selected?.id === product.id ? 'check' : 'arrow'" /></button></div>
          </article></div>
          <p class="photo-credit-note">{{ t('design.photoNote') }} <a href="/media/ARTWORK_CREDITS.txt" target="_blank" rel="noopener">{{ t('design.artCredits') }}</a></p>
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
                <ProductPhoto :kind="selected.art" />
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
            <div class="checkout-extra"><AppIcon name="gift" /><div><strong>{{ t('design.checkoutExtra') }}</strong><p>{{ t('design.checkoutExtraText') }}</p></div></div><p class="demo-note">
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

        <section id="how-it-works" class="how-section" :aria-label="t('steps.label')"><div class="section-heading"><div><p class="eyebrow">{{ t('design.how') }}</p><h2>{{ t('design.stepsTitle') }}</h2></div><AppIcon name="spark" /></div><div class="how-it-works"><div><span class="step-icon"><AppIcon name="bag" /></span><p class="eyebrow">{{ t('design.stepShop') }}</p><h3>{{ t('steps.first') }}</h3><p>{{ t('steps.firstText') }}</p></div><div><span class="step-icon"><AppIcon name="shield" /></span><p class="eyebrow">{{ t('design.stepPay') }}</p><h3>{{ t('steps.second') }}</h3><p>{{ t('steps.secondText') }}</p></div><div><span class="step-icon"><AppIcon name="gift" /></span><p class="eyebrow">{{ t('design.stepGift') }}</p><h3>{{ t('steps.third') }}</h3><p>{{ t(store?.gifts.isDemo === false ? 'gift.aiSteps' : 'steps.thirdText') }}</p></div></div></section>
      </template>
    </main>
    <footer><div class="footer-top"><div><span class="footer-brand">{{ t('footer.brand') }}<AppIcon /></span><p>{{ t('design.footerNote') }}</p></div><nav class="legal-links"><a href="/legal">{{ t('footer.legal') }}</a><a href="/privacy">{{ t('footer.privacy') }}</a></nav></div><div class="footer-bottom"><span>Museum Puzzles · Delight AI · Hackathon 2026</span><span>{{ t(labPage ? (store?.gifts.isDemo === false ? 'lab.aiFooter' : 'lab.mockFooter') : (store?.gifts.isDemo === false ? 'gift.aiShort' : 'design.demoShort')) }}</span><span>{{ t('footer.smile') }} <span aria-hidden="true">✳</span></span></div></footer>
  </div>
</template>
