import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, errorResult } from '@dropdeck/shared';

/**
 * POST /api/d/{tenantId}/{dropId}/ticket  (week 2 — Queue, claim, checkout)
 *
 * TODO
 * - Load the drop (cache per instance for a few seconds); reject unless Live (NOT_LIVE).
 * - Before admission start (openAt + graceSec): draw r ~ U[0,1) with crypto, ADD 1 to a random
 *   early-counter shard, return a signed ticket { r }.
 * - After: hand out the next number from this instance's block; when the block is empty,
 *   ADD blockSize to the late counter (one write per block) and take [v - blockSize, v).
 * - Emit a structured metric per ticket: arrival time, r or n, block id (fairness experiment).
 */
export async function handler(_event: APIGatewayProxyEventV2) {
  return errorResult(new ApiError('NOT_IMPLEMENTED', 'Ticket issue is planned for week 2'));
}
