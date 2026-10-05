import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, errorResult } from '@dropdeck/shared';

/**
 * POST /api/d/{tenantId}/{dropId}/claim  (week 2)
 *
 * TODO
 * - verifyTicket(); compute admittedAt() from the ticket, drop config and frozen earlyCount;
 *   checkAdmission() → NOT_ADMITTED (with retryAfter) or ADMISSION_EXPIRED.
 * - Idempotency: conditional put of the hold keyed by ticketId (attribute_not_exists);
 *   on conflict return the existing hold.
 * - Reserve: UpdateItem on a random stock shard, ConditionExpression `sold + :q <= capacity`.
 *   On ConditionalCheckFailedException try the remaining shards before VARIANT_SOLD_OUT.
 *   If the reserve fails after the hold put, delete the hold (compensation).
 * - Hold carries explicit expiresAt and the sparse GSI1 attributes; return a signed hold token.
 */
export async function handler(_event: APIGatewayProxyEventV2) {
  return errorResult(new ApiError('NOT_IMPLEMENTED', 'Claim is planned for week 2'));
}
