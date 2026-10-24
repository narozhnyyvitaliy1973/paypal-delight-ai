interface Callbacks {
  onApprove(data: { orderId: string }): Promise<void>;
  onCancel(data: { orderId?: string }): void | Promise<void>;
  onError(error: unknown): void;
}
export interface PaymentSession {
  start(
    options: { presentationMode: "auto" },
    order: Promise<{ orderId: string }>,
  ): Promise<void>;
  hasReturned(): boolean;
  resume(): Promise<void>;
}
interface PayPalInstance {
  findEligibleMethods(options?: {
    currencyCode: string;
  }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: Callbacks): PaymentSession;
}
declare global {
  interface Window {
    paypal?: {
      createInstance(options: {
        clientId: string;
        components: string[];
        pageType: string;
      }): Promise<PayPalInstance>;
    };
  }
}

let loading: Promise<void> | undefined;
function loadSdk() {
  if (window.paypal) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://www.sandbox.paypal.com/web-sdk/v6/core";
    script.async = true;
    const timeout = window.setTimeout(() => fail(), 20_000);
    function fail() {
      window.clearTimeout(timeout);
      script.remove();
      loading = undefined;
      reject(
        new Error(
          "PayPal could not load. Check your connection and allow PayPal in your browser.",
        ),
      );
    }
    script.onerror = fail;
    script.onload = () => {
      window.clearTimeout(timeout);
      if (!window.paypal) return fail();
      resolve();
    };
    document.head.append(script);
  });
  return loading;
}
export async function setupPayPal(clientId: string, callbacks: Callbacks) {
  await loadSdk();
  const instance = await window.paypal!.createInstance({
    clientId,
    components: ["paypal-payments"],
    pageType: "checkout",
  });
  const eligibility = await instance.findEligibleMethods({
    currencyCode: "EUR",
  });
  if (!eligibility.isEligible("paypal"))
    throw new Error(
      "PayPal is not available in this browser. Please try another browser.",
    );
  return instance.createPayPalOneTimePaymentSession(callbacks);
}
