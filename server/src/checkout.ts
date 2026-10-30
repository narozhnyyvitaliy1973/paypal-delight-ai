import { AppError, PayPalError } from "./errors.js";
import { OrderStore, type Order } from "./database.js";
import { object, type PayPalGateway } from "./paypal.js";
import { products, money } from "./catalog.js";

const paymentMismatch = () =>
  new AppError(
    409,
    "PAYMENT_MISMATCH",
    "Payment details need manual review. No gift has been issued.",
  );
const providerId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z0-9]{8,32}$/.test(value);

export function validateOrder(data: unknown, order: Order, creating = false) {
  const remote = object(data);
  const units = remote.purchase_units;
  if (
    !providerId(remote.id) ||
    (!creating && remote.id !== order.paypal_order_id) ||
    remote.intent !== "CAPTURE" ||
    !Array.isArray(units) ||
    units.length !== 1
  )
    throw paymentMismatch();
  const unit = object(units[0]);
  const amount = object(unit.amount);
  const merchant = object(unit.payee).merchant_id;
  if (
    unit.reference_id !== order.id ||
    unit.custom_id !== order.id ||
    unit.invoice_id !== order.id ||
    amount.currency_code !== order.currency ||
    amount.value !== money(order.amount_minor) ||
    typeof merchant !== "string" ||
    !merchant ||
    (!creating && merchant !== order.payee_id)
  )
    throw paymentMismatch();
  const items = unit.items;
  if (
    !Array.isArray(items) ||
    items.length !== 1 ||
    object(items[0]).sku !== order.product_id ||
    object(items[0]).quantity !== "1"
  )
    throw paymentMismatch();
  return { remote, unit, merchant, paypalId: remote.id };
}

export class Checkout {
  constructor(
    private store: OrderStore,
    private paypal: PayPalGateway,
  ) {}
  private async locked<T>(id: string, action: () => Promise<T>) {
    const token = this.store.claim(id);
    try {
      return await action();
    } finally {
      this.store.release(id, token);
    }
  }
  async create(owner: string, productId: string, requestId: string, origin?: string) {
    const product = products.find((item) => item.id === productId);
    if (!product)
      throw new AppError(
        400,
        "INVALID_PRODUCT",
        "Choose a product from the store.",
      );
    const order = this.store.prepare(owner, requestId, product);
    if (order.paypal_order_id) return this.store.publicOrder(order);
    return this.locked(order.id, async () => {
      // Provider deduplication has a finite lifetime. Never blindly replay old ambiguous creates.
      if (Date.now() - order.created_at > 5 * 60_000)
        throw new AppError(
          409,
          "ORDER_EXPIRED",
          "This checkout attempt expired. Start a new purchase.",
        );
      const data = await this.paypal.create(order, origin);
      const result = validateOrder(data, order, true);
      if (
        !["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"].includes(
          String(result.remote.status),
        )
      )
        throw paymentMismatch();
      this.store.created(order.id, result.paypalId, result.merchant);
      return this.store.publicOrder(this.store.get(order.id)!);
    });
  }
  private record(data: unknown, order: Order) {
    const result = validateOrder(data, order);
    const captures = object(result.unit.payments).captures;
    if (
      captures !== undefined &&
      (!Array.isArray(captures) || captures.length !== 1)
    )
      throw paymentMismatch();
    const capture = Array.isArray(captures) ? object(captures[0]) : null;
    if (capture) {
      const amount = object(capture.amount);
      if (
        !providerId(capture.id) ||
        amount.value !== money(order.amount_minor) ||
        amount.currency_code !== order.currency
      )
        throw paymentMismatch();
      if (
        capture.status === "COMPLETED" &&
        result.remote.status === "COMPLETED" &&
        capture.final_capture === true
      ) {
        this.store.complete(order.id, capture.id);
        return "COMPLETED";
      }
      if (capture.status === "PENDING") {
        this.store.observedCapture(order.id, "PENDING", capture.id);
        return "PENDING";
      }
      if (["DECLINED", "DENIED", "FAILED"].includes(String(capture.status))) {
        this.store.observedCapture(order.id, "DECLINED", capture.id);
        return "DECLINED";
      }
      throw paymentMismatch();
    }
    if (result.remote.status === "COMPLETED") throw paymentMismatch();
    if (result.remote.status === "VOIDED") {
      this.store.status(order.id, "CANCELLED");
      return "CANCELLED";
    }
    if (
      !["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"].includes(
        String(result.remote.status),
      )
    )
      throw paymentMismatch();
    return String(result.remote.status);
  }
  async process(owner: string, id: string, capture: boolean) {
    const initial = this.store.owned(id, owner);
    if (initial.status === "COMPLETED") return this.store.publicOrder(initial);
    if (!initial.paypal_order_id)
      throw new AppError(
        409,
        "ORDER_NOT_READY",
        "Order creation has not finished. Retry the checkout request.",
      );
    if (["CANCELLED", "DECLINED", "REVIEW"].includes(initial.status))
      return this.store.publicOrder(initial);
    return this.locked(id, async () => {
      const order = this.store.owned(id, owner);
      try {
        const remote = await this.paypal.get(order.paypal_order_id!);
        const status = this.record(remote, order);
        if (status === "APPROVED" && capture) {
          this.store.attempted(id);
          try {
            const captured = object(
              await this.paypal.capture(
                order.paypal_order_id!,
                order.capture_request_id,
              ),
            );
            if (captured.id !== order.paypal_order_id) throw paymentMismatch();
            // Capture responses can omit purchase-unit metadata; verify a fresh full order resource.
            this.record(await this.paypal.get(order.paypal_order_id!), order);
          } catch (error) {
            if (
              error instanceof PayPalError &&
              error.issue === "ORDER_ALREADY_CAPTURED"
            ) {
              this.record(await this.paypal.get(order.paypal_order_id!), order);
            } else {
              throw error;
            }
          }
        } else if (
          capture &&
          ["CREATED", "PAYER_ACTION_REQUIRED"].includes(status)
        ) {
          throw new AppError(
            409,
            "APPROVAL_REQUIRED",
            "Approve this order in PayPal before completing checkout.",
          );
        }
      } catch (error) {
        if (error instanceof AppError && error.code === "PAYMENT_MISMATCH")
          this.store.status(id, "REVIEW");
        if (
          error instanceof PayPalError &&
          [
            "INSTRUMENT_DECLINED",
            "PAYER_CANNOT_PAY",
            "TRANSACTION_REFUSED",
            "PAYMENT_DENIED",
            "INSUFFICIENT_FUNDS",
          ].includes(error.issue)
        ) {
          this.store.status(id, "DECLINED");
          return this.store.publicOrder(this.store.get(id)!);
        }
        throw error;
      }
      return this.store.publicOrder(this.store.get(id)!);
    });
  }
  async cancel(owner: string, id: string) {
    const order = this.store.owned(id, owner);
    if (order.status === "COMPLETED") return this.store.publicOrder(order);
    if (order.capture_attempted) return this.process(owner, id, false);
    return this.locked(id, async () => {
      this.store.status(id, "CANCELLED");
      return this.store.publicOrder(this.store.get(id)!);
    });
  }
}
