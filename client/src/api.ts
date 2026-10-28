export type GiftType = 'caricature' | 'greeting-card' | 'mini-comic';
export interface Product {
  id: string;
  name: string;
  description: string;
  amountMinor: number;
  currency: string;
  category: string;
  art: string;
  color: string;
  translations: { de: { name: string; description: string } };
}
export interface Store {
  labAvailable: boolean;
  products: Product[];
  gifts: { isDemo: boolean; provider: 'mock' | 'cloudflare'; enabled: boolean };
  checkout: {
    enabled: boolean;
    clientId: string | null;
    currency: string;
    environment: "sandbox";
  };
}
export type GiftView = Pick<Order, 'id' | 'gift'>;
export interface GiftInput {
  type: GiftType; language: string; wishes: string;
  recipientName?: string; occasion?: string; characterName?: string;
  photo?: { data: string; contentType: string; consent: boolean; cloudflareConsent?: boolean };
}
export interface LabRun {
  id: string; productId: string; type: GiftType; language: 'en' | 'de';
  status: 'STARTED' | 'COMPLETED' | 'REJECTED' | 'UNCERTAIN'; createdAt: number;
  errorCode: string | null; result: NonNullable<Order['gift']>['result'];
}
export interface Order {
  id: string;
  product: { id: string; name: string };
  amountMinor: number;
  currency: string;
  status:
    | "CREATING"
    | "CREATED"
    | "PENDING"
    | "COMPLETED"
    | "CANCELLED"
    | "DECLINED"
    | "REVIEW";
  paypalOrderId: string | null;
  captureId: string | null;
  captureAttempted: boolean;
  gift: { id: string; status: 'AVAILABLE' | 'GENERATING' | 'COMPLETED' | 'REVIEW'; result: null | {
    type: GiftType; language: 'en' | 'de'; provider: 'mock' | 'openai' | 'cloudflare'; isDemo: boolean;
    text: string; width: number; height: number; createdAt: number; imageUrl: string; downloadUrl: string;
  } } | null;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  const generatingGift = body !== undefined && /^\/(?:ai-lab\/runs|orders\/[^/]+\/gift)$/.test(path);
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(generatingGift ? 330_000 : 65_000),
    });
  } catch {
    throw new ApiError(
      "NETWORK_ERROR",
      "Connection interrupted. Check this order before starting another purchase.",
    );
  }
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.code ?? "REQUEST_FAILED",
      data.message ?? "The request could not be completed.",
    );
  return data as T;
}
export const formatMoney = (minor: number, currency = "EUR", locale = "en") =>
  new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-IE', { style: "currency", currency }).format(
    minor / 100,
  );
