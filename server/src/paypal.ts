import { PayPalError } from "./errors.js";
import { money } from "./catalog.js";
import type { Order } from "./database.js";

// Intentionally fixed: no Live endpoint can be selected by environment or request.
export const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
export interface PayPalGateway {
  create(order: Order): Promise<unknown>;
  get(id: string): Promise<unknown>;
  capture(id: string, requestId: string): Promise<unknown>;
}

export class PayPalClient implements PayPalGateway {
  private token: { value: string; expires: number } | undefined;
  private tokenRequest: Promise<string> | undefined;
  constructor(
    private clientId: string,
    private secret: string,
    private origin: string,
    private transport: typeof fetch = fetch,
  ) {}

  private async send(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(`${PAYPAL_BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch {
      throw new PayPalError(502, "UNAVAILABLE");
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new PayPalError(502, "INVALID_RESPONSE");
    }
    if (!response.ok) {
      const details = object(data).details;
      const issue = Array.isArray(details)
        ? object(details[0]).issue
        : undefined;
      // Raw responses contain payer data. Keep only a bounded error code.
      throw new PayPalError(
        response.status,
        typeof issue === "string" && /^[A-Z_]{1,80}$/.test(issue)
          ? issue
          : "UNAVAILABLE",
      );
    }
    return data;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = (async () => {
        const data = object(
          await this.send("/v1/oauth2/token", {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: "grant_type=client_credentials",
          }),
        );
        if (
          typeof data.access_token !== "string" ||
          typeof data.expires_in !== "number" ||
          data.expires_in <= 0
        ) {
          throw new PayPalError(502, "INVALID_RESPONSE");
        }
        this.token = {
          value: data.access_token,
          expires: Date.now() + Math.max(0, data.expires_in - 60) * 1000,
        };
        return this.token.value;
      })();
    }
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = undefined;
    }
  }
  private async request(
    path: string,
    method: string,
    requestId?: string,
    body?: unknown,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      try {
        return await this.send(path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
            ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (
          error instanceof PayPalError &&
          error.httpStatus === 401 &&
          attempt === 0
        ) {
          this.token = undefined;
          continue;
        }
        throw error;
      }
    }
    throw new PayPalError(502);
  }
  create(order: Order) {
    const amount = { currency_code: "EUR", value: money(order.amount_minor) };
    return this.request(
      "/v2/checkout/orders",
      "POST",
      order.create_request_id,
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: order.id,
            custom_id: order.id,
            invoice_id: order.id,
            amount: { ...amount, breakdown: { item_total: amount } },
            items: [
              {
                name: order.product_name,
                sku: order.product_id,
                quantity: "1",
                unit_amount: amount,
                category: "PHYSICAL_GOODS",
              },
            ],
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Museum Puzzles",
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
              return_url: `${this.origin}/?order=${order.id}`,
              cancel_url: `${this.origin}/?order=${order.id}&cancelled=1`,
            },
          },
        },
      },
    );
  }
  get(id: string) {
    return this.request(`/v2/checkout/orders/${encodeURIComponent(id)}`, "GET");
  }
  capture(id: string, requestId: string) {
    return this.request(
      `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
      "POST",
      requestId,
      {},
    );
  }
}
