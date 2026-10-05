import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

/** Early tickets carry a random draw position r in [0,1); late tickets carry a sequence number n. */
export type TicketClaims =
  | { k: 'ticket'; t: string; d: string; r: number; iat: number; exp?: number }
  | { k: 'ticket'; t: string; d: string; n: number; iat: number; exp?: number };

export interface HoldClaims {
  k: 'hold';
  t: string;
  d: string;
  /** Hold id = the ticket's identity (r or n), so one hold per ticket. */
  h: string;
  iat: number;
  /** Epoch ms after which the token is refused. */
  exp?: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function sign(claims: TicketClaims | HoldClaims, key: string): string {
  const body = b64(JSON.stringify(claims));
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify<T extends TicketClaims | HoldClaims>(token: string, key: string, kind: T['k'], nowMs = Date.now()): T {
  const [body, mac] = token.split('.');
  if (!body || !mac) throw new ApiError('BAD_TOKEN', 'Malformed token');
  const expected = createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ApiError('BAD_TOKEN', 'Signature mismatch');
  }
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
  if (claims.k !== kind) throw new ApiError('BAD_TOKEN', `Expected a ${kind} token`);
  if (claims.exp !== undefined && nowMs > claims.exp) throw new ApiError('BAD_TOKEN', `This ${kind} has expired`);
  return claims;
}

/** Stable ticket identity used as the hold key. */
export function ticketId(c: TicketClaims): string {
  return 'r' in c ? `r${c.r.toFixed(12)}` : `n${c.n}`;
}

export const verifyTicket = (token: string, key: string, nowMs?: number) => verify<TicketClaims>(token, key, 'ticket', nowMs);
export const verifyHold = (token: string, key: string, nowMs?: number) => verify<HoldClaims>(token, key, 'hold', nowMs);
