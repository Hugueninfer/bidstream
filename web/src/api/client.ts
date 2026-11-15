import type {
  AwardRequest,
  Bid,
  BidsResponse,
  CreateBidRequest,
  CreateRfqRequest,
  HealthResponse,
  PriceEstimate,
  Rfq,
  RfqListResponse,
  RfqStatus,
  SkusResponse,
} from "./types";

export const TENANT_ID = "tenant_demo";
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

/** Error from edge-gateway (`{error:{code,message}}`) or from the network. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** Worth retrying automatically: network errors and 5xx (not 4xx business errors). */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

const FALLBACK_CODES: Record<number, string> = {
  400: "validation_error",
  404: "not_found",
  409: "conflict",
  503: "upstream_unavailable",
};

/** Turn an HTTP status + raw body into an ApiError, tolerating non-JSON bodies (e.g. a proxy 502 page). */
export function toApiError(status: number, bodyText: string): ApiError {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (err && typeof err === "object") {
        const { code, message } = err as { code?: unknown; message?: unknown };
        if (typeof code === "string") {
          return new ApiError(status, code, typeof message === "string" ? message : code);
        }
      }
    }
  } catch {
    // not JSON: fall through
  }
  const code = FALLBACK_CODES[status] ?? (status >= 500 ? "upstream_unavailable" : `http_${status}`);
  return new ApiError(status, code, `HTTP ${status}`);
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

export type ApiResult<T> = { data: T; status: number };

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Tenant-Id": TENANT_ID,
    ...opts.headers,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network_error", "Can't reach the API. Check your connection and try again.");
  }

  const text = await res.text();
  if (!res.ok) throw toApiError(res.status, text);
  return { data: (text ? JSON.parse(text) : null) as T, status: res.status };
}

const get = async <T>(path: string, signal?: AbortSignal) => (await request<T>(path, { signal })).data;

export const api = {
  skus: (signal?: AbortSignal) => get<SkusResponse>("/v1/skus", signal),

  listRfqs: (status?: RfqStatus, signal?: AbortSignal) =>
    get<RfqListResponse>(status ? `/v1/rfqs?status=${status}` : "/v1/rfqs", signal),

  getRfq: (rfqId: string, signal?: AbortSignal) =>
    get<Rfq>(`/v1/rfqs/${encodeURIComponent(rfqId)}`, signal),

  createRfq: async (body: CreateRfqRequest) =>
    (await request<Rfq>("/v1/rfqs", { method: "POST", body })).data,

  listBids: (rfqId: string, signal?: AbortSignal) =>
    get<BidsResponse>(`/v1/rfqs/${encodeURIComponent(rfqId)}/bids`, signal),

  /** 201 on create, 200 on idempotent replay. */
  submitBid: (rfqId: string, body: CreateBidRequest, idempotencyKey: string) =>
    request<Bid>(`/v1/rfqs/${encodeURIComponent(rfqId)}/bids`, {
      method: "POST",
      body,
      headers: { "Idempotency-Key": idempotencyKey },
    }),

  award: async (rfqId: string, body: AwardRequest) =>
    (await request<Rfq>(`/v1/rfqs/${encodeURIComponent(rfqId)}/award`, { method: "POST", body })).data,

  estimate: (sku: string, qty: number, signal?: AbortSignal) =>
    get<PriceEstimate>(`/v1/estimate?${new URLSearchParams({ sku, qty: String(qty) })}`, signal),

  health: (signal?: AbortSignal) => get<HealthResponse>("/v1/health", signal),
};

export const eventsUrl = () => `${API_BASE_URL}/v1/events?tenant_id=${encodeURIComponent(TENANT_ID)}`;

/** crypto.randomUUID is only available in secure contexts; fall back to getRandomValues. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // insecure context
    }
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
