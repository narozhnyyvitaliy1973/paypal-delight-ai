import Fastify, { type FastifyServerOptions } from "fastify";
import type { FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { createHash, randomBytes } from "node:crypto";
import { readSettings, type Settings } from "./config.js";
import { OrderStore } from "./database.js";
import { PayPalClient, type PayPalGateway } from "./paypal.js";
import { Checkout } from "./checkout.js";
import { AppError, PayPalError } from "./errors.js";
import { products } from "./catalog.js";
import { createGiftProvider } from './gifts/provider.js';

interface Dependencies {
  settings?: Settings;
  store?: OrderStore;
  paypal?: PayPalGateway;
  rateLimit?: boolean;
}
const uuid = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
};
const params = {
  type: "object",
  required: ["id"],
  properties: { id: uuid },
  additionalProperties: false,
};
const emptyBody = { type: "object", additionalProperties: false };

export function buildApp(
  options: FastifyServerOptions = {},
  dependencies: Dependencies = {},
) {
  const settings = dependencies.settings ?? readSettings();
  const giftProvider = createGiftProvider(settings.aiProvider);
  const store = dependencies.store ?? new OrderStore(settings.databasePath);
  const paypal =
    dependencies.paypal ??
    new PayPalClient(settings.clientId, settings.clientSecret, settings.origin);
  const checkout = new Checkout(store, paypal);
  const enabled = Boolean(settings.clientId && settings.clientSecret);
  const app = Fastify({
    ...options,
    bodyLimit: 4096,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(cookie);
  app.register(rateLimit, { global: false });
  app.addHook("onClose", async () => store.close());
  // Register routes after the plugins so their onRoute hooks apply to payment endpoints.
  app.register(async function checkoutRoutes(app) {
    const limits =
      dependencies.rateLimit === false
        ? false
        : { max: 30, timeWindow: "1 minute" };
    const owner = (request: FastifyRequest) => {
      const token = request.cookies.delight_session;
      if (!token || !/^[a-f0-9]{64}$/.test(token))
        throw new AppError(
          401,
          "SESSION_REQUIRED",
          "Reload the store to start your browser session.",
        );
      return createHash("sha256").update(token).digest("hex");
    };
    app.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Referrer-Policy", "same-origin");
      if (request.method === "POST") {
        if (request.headers.origin !== settings.origin)
          throw new AppError(
            403,
            "ORIGIN_REJECTED",
            "Open checkout from the configured store address.",
          );
        if (!request.headers["content-type"]?.startsWith("application/json"))
          throw new AppError(415, "JSON_REQUIRED", "JSON request required.");
        owner(request);
      }
    });
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof AppError)
        return reply
          .code(error.statusCode)
          .send({ code: error.code, message: error.message });
      if (error instanceof PayPalError) {
        request.log.warn(
          { issue: error.issue, providerStatus: error.httpStatus },
          "PayPal Sandbox request failed",
        );
        return reply.code(502).send({
          code: "PAYPAL_UNAVAILABLE",
          message:
            "PayPal could not confirm the operation. Check this order before starting another purchase.",
        });
      }
      const known = error as { validation?: unknown; statusCode?: number };
      if (known.validation)
        return reply.code(400).send({
          code: "INVALID_REQUEST",
          message: "Invalid checkout request.",
        });
      if (known.statusCode === 429)
        return reply.code(429).send({
          code: "RATE_LIMITED",
          message: "Too many requests. Please wait a minute.",
        });
      if (known.statusCode && known.statusCode >= 400 && known.statusCode < 500)
        return reply
          .code(known.statusCode)
          .send({ code: "INVALID_REQUEST", message: "Invalid request." });
      request.log.error(
        { requestId: request.id },
        "Unexpected checkout failure",
      );
      return reply.code(500).send({
        code: "INTERNAL_ERROR",
        message:
          "The operation could not be confirmed. Please check the order again.",
      });
    });
    app.get("/api/health", async () => ({
      status: "ok",
      service: "paypal-delight-ai",
    }));
    // Public fixed sample only: no upload, generation job, payment or gift redemption.
    app.get('/api/gifts/demo/caricature.png', async (_request, reply) => {
      const result = await giftProvider.generate({ type: 'caricature', product: products[0], language: 'en', wishes: '' });
      return reply.type(result.image.contentType).header('X-Delight-Demo', 'true').send(result.image.bytes);
    });
    app.get("/api/store", async (request, reply) => {
      reply.setCookie(
        "delight_session",
        request.cookies.delight_session?.match(/^[a-f0-9]{64}$/)?.[0] ??
          randomBytes(32).toString("hex"),
        {
          httpOnly: true,
          secure: settings.production,
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24 * 30,
        },
      );
      return {
        products,
        checkout: {
          enabled,
          clientId: enabled ? settings.clientId : null,
          currency: "EUR",
          environment: "sandbox",
        },
      };
    });
    const requirePayPal = async () => {
      if (!enabled)
        throw new AppError(
          503,
          "CHECKOUT_UNAVAILABLE",
          "Sandbox checkout is not configured yet.",
        );
    };
    app.post<{ Body: { productId: string; requestId: string } }>(
      "/api/orders",
      {
        config: { rateLimit: limits },
        preHandler: requirePayPal,
        schema: {
          body: {
            type: "object",
            required: ["productId", "requestId"],
            additionalProperties: false,
            properties: {
              productId: { type: "string", minLength: 1, maxLength: 64 },
              requestId: uuid,
            },
          },
        },
      },
      async (request) =>
        checkout.create(
          owner(request),
          request.body.productId,
          request.body.requestId,
        ),
    );
    app.get<{ Params: { id: string } }>(
      "/api/orders/:id",
      { schema: { params } },
      async (request) =>
        store.publicOrder(store.owned(request.params.id, owner(request))),
    );
    for (const operation of ["capture", "reconcile", "cancel"] as const) {
      app.post<{ Params: { id: string } }>(
        `/api/orders/:id/${operation}`,
        {
          config: { rateLimit: limits },
          preHandler: requirePayPal,
          schema: { params, body: emptyBody },
        },
        async (request) =>
          operation === "cancel"
            ? checkout.cancel(owner(request), request.params.id)
            : checkout.process(
                owner(request),
                request.params.id,
                operation === "capture",
              ),
      );
    }
    app.get<{ Params: { id: string } }>(
      "/api/orders/:id/gift",
      { schema: { params } },
      async (request) => {
        const order = store.owned(request.params.id, owner(request));
        if (order.status !== "COMPLETED" || !store.gift(order.id))
          throw new AppError(
            409,
            "PAYMENT_REQUIRED",
            "A confirmed purchase is required for a gift.",
          );
        return store.publicOrder(order);
      },
    );
  });
  return app;
}
