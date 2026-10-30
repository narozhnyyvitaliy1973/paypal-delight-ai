import Fastify, { type FastifyServerOptions } from "fastify";
import type { FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readSettings, type Settings } from "./config.js";
import { OrderStore } from "./database.js";
import { PayPalClient, type PayPalGateway } from "./paypal.js";
import { Checkout } from "./checkout.js";
import { AppError, PayPalError } from "./errors.js";
import { products } from "./catalog.js";
import { createGiftProvider, MockGiftProvider, type GiftProvider } from './gifts/provider.js';
import { Gifts, type CreateGift } from './gifts/service.js';
import { AiLab } from './gifts/lab.js';
import { aiUsage } from './gifts/limits.js';

interface Dependencies {
  settings?: Settings;
  store?: OrderStore;
  paypal?: PayPalGateway;
  rateLimit?: boolean;
  giftProvider?: GiftProvider;
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
const giftBody = {
        type: 'object', additionalProperties: false, required: ['type', 'language', 'wishes'],
        properties: {
          type: { type: 'string', enum: ['caricature', 'greeting-card', 'mini-comic'] }, language: { type: 'string', enum: ['en', 'de'] },
          wishes: { type: 'string', maxLength: 500 },
          recipientName: { type: 'string', minLength: 1, maxLength: 80 },
          occasion: { type: 'string', minLength: 1, maxLength: 120 },
          characterName: { type: 'string', minLength: 1, maxLength: 80 },
          photo: { type: 'object', additionalProperties: false, required: ['data', 'contentType', 'consent'], properties: {
            data: { type: 'string', minLength: 1, maxLength: 6990508 },
            contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] }, consent: { type: 'boolean' }, cloudflareConsent: { type: 'boolean' },
          } },
        },
      };
const emptyBody = { type: "object", additionalProperties: false };

export function buildApp(
  options: FastifyServerOptions = {},
  dependencies: Dependencies = {},
) {
  const settings = dependencies.settings ?? readSettings();
  const giftProvider = dependencies.giftProvider ?? createGiftProvider(settings.aiProvider, settings.ai);
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
  const gifts = new Gifts(store, giftProvider, settings.ai, event => app.log.info(event, 'Gift generation'));
  const lab = new AiLab(store, giftProvider, settings.ai);
  const labAllowed = (request: FastifyRequest) => {
    const token = request.headers['x-delight-lab-token'];
    return settings.lab.enabled && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip) &&
      typeof token === 'string' && token.length === 64 && /^[a-f0-9]{64}$/.test(token) &&
      timingSafeEqual(Buffer.from(token), Buffer.from(settings.lab.proxyToken));
  };
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
        if (!settings.allowedOrigins.includes(request.headers.origin ?? ''))
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
      const result = await new MockGiftProvider().generate({ type: 'caricature', product: products[0], language: 'en', wishes: '' });
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
        labAvailable: labAllowed(request),
        gifts: { isDemo: giftProvider.name === 'mock', provider: giftProvider.name, enabled: giftProvider.name === 'mock' || settings.ai.enabled },
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
          request.headers.origin,
        ),
    );
    app.get('/api/orders', async request => store.purchases(owner(request)));
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
      async request => gifts.read(owner(request), request.params.id),
    );
    app.post<{ Params: { id: string }; Body: CreateGift }>('/api/orders/:id/gift', {
      // Base64 overhead for a maximum 5 MiB photo; all payment routes retain 4 KiB.
      bodyLimit: 7 * 1024 * 1024,
      config: { rateLimit: limits },
      schema: { params, body: giftBody },
    }, async (request, reply) => {
      const order = await gifts.create(owner(request), request.params.id, request.body);
      if (order.gift?.status === 'GENERATING') reply.code(202);
      return order;
    });
    const requireLab = async (request: FastifyRequest) => {
      if (!labAllowed(request)) throw new AppError(404, 'AI_LAB_UNAVAILABLE', 'Private AI lab is unavailable.');
      owner(request);
    };
    app.get('/api/ai-lab', { preHandler: requireLab }, async request => ({
      runs: lab.list(owner(request)), usage: aiUsage(store.db, owner(request)),
      limits: { requests: settings.ai.dailyRequests, sessionRequests: settings.ai.sessionDailyRequests,
        neurons: settings.ai.dailyNeurons, concurrent: settings.ai.maxConcurrent },
      resetsAt: (Math.floor(Date.now() / 86400000) + 1) * 86400000,
    }));
    app.post<{ Body: CreateGift & { requestId: string; productId: string } }>('/api/ai-lab/runs', {
      bodyLimit: 7 * 1024 * 1024, preHandler: requireLab, config: { rateLimit: limits },
      schema: { body: { ...giftBody, required: [...giftBody.required, 'requestId', 'productId'],
        properties: { ...giftBody.properties, requestId: uuid, productId: { type: 'string', minLength: 1, maxLength: 64 } } } },
    }, async (request, reply) => {
      const result = await lab.create(owner(request), request.body.requestId, request.body.productId, request.body);
      if (result.status === 'STARTED') reply.code(202);
      return result;
    });
    app.get<{ Params: { id: string } }>('/api/ai-lab/runs/:id', { preHandler: requireLab, schema: { params } },
      async request => lab.read(owner(request), request.params.id));
    for (const action of ['image', 'download'] as const) {
      app.get<{ Params: { id: string } }>(`/api/ai-lab/runs/:id/${action}`, { preHandler: requireLab, schema: { params } }, async (request, reply) => {
        const image = lab.image(owner(request), request.params.id);
        return reply.type('image/png').header('Content-Disposition', `${action === 'download' ? 'attachment' : 'inline'}; filename="delight-test-${image.type}-${request.params.id}.png"`).send(image.bytes);
      });
    }
    for (const action of ['image', 'download'] as const) {
      app.get<{ Params: { id: string } }>(`/api/orders/:id/gift/${action}`, { schema: { params } }, async (request, reply) => {
        const image = gifts.image(owner(request), request.params.id);
        return reply.type('image/png').header('Content-Disposition', `${action === 'download' ? 'attachment' : 'inline'}; filename="delight-${image.type}-${request.params.id}.png"`).send(image.bytes);
      });
    }
  });
  return app;
}
