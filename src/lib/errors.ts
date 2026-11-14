export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INSUFFICIENT_FUNDS"
  | "OUT_OF_STOCK"
  | "PRODUCT_UNAVAILABLE"
  | "LIMIT_REACHED"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_STATE"
  | "OVERLAPPING_PERIOD"
  | "ACCOUNT_NOT_LINKED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INSUFFICIENT_FUNDS: 409,
  OUT_OF_STOCK: 409,
  PRODUCT_UNAVAILABLE: 409,
  LIMIT_REACHED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_STATE: 409,
  OVERLAPPING_PERIOD: 409,
  ACCOUNT_NOT_LINKED: 403,
  INTERNAL: 500,
};

/** An expected, user-presentable failure. Anything else is treated as a bug (HTTP 500). */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** For RATE_LIMITED: seconds until the client may try again. */
  readonly retryAfterSeconds?: number;
  /** For VALIDATION: per-field messages, keyed by field name. */
  readonly fields?: Record<string, string>;

  constructor(code: ErrorCode, message: string, extra: { retryAfterSeconds?: number; fields?: Record<string, string> } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.fields = extra.fields;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
