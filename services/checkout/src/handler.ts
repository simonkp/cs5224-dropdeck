import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, errorResult } from '@dropdeck/shared';

/**
 * GET  /api/holds/{holdId}           resume a hold after refresh
 * POST /api/holds/{holdId}/otp       email → 6-digit code via SES (skipped when verification is off)
 * POST /api/holds/{holdId}/confirm   code + name → order
 * (week 2 basic path; hardened in week 3)
 *
 * TODO
 * - verifyHold(); reject HOLD_EXPIRED if state != active or expiresAt passed.
 * - OTP: normaliseEmail(), store sha256(code) + otpExpiresAt + attempts on the hold item;
 *   resend after 30 s, max 3 sends and 5 attempts → OTP_LOCKED.
 * - Confirm: conditional put of the buyer-limit item (attribute_not_exists) → LIMIT_REACHED and
 *   release the hold on failure; then flip hold active→confirmed (conditional) and write the order.
 * - Response: order ref, merchant PayNow details, survey code.
 */
export async function handler(_event: APIGatewayProxyEventV2) {
  return errorResult(new ApiError('NOT_IMPLEMENTED', 'Checkout is planned for week 2'));
}
