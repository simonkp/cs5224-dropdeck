/** Shared error codes. Every error body is `{ code, message, retryAfter? }`. */
export const ErrorCodes = {
  NOT_LIVE: 409,
  NOT_ADMITTED: 403,
  ADMISSION_EXPIRED: 410,
  BAD_TOKEN: 401,
  SOLD_OUT: 409,
  VARIANT_SOLD_OUT: 409,
  HOLD_EXPIRED: 410,
  LIMIT_REACHED: 409,
  OTP_INVALID: 400,
  OTP_LOCKED: 429,
  RATE_LIMITED: 429,
  TENANT_BUDGET: 429,
  LOCKED_FOR_EDIT: 409,
  INVALID_STATE: 409,
  SLUG_TAKEN: 409,
  PLAN_LIMIT: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  NOT_IMPLEMENTED: 501,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get status(): number {
    return ErrorCodes[this.code];
  }
  toBody() {
    return { code: this.code, message: this.message, ...(this.retryAfter ? { retryAfter: this.retryAfter } : {}) };
  }
}
