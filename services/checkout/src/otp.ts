import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ApiError, emailHash, isPlausibleEmail, keys, normaliseEmail, type Drop, type Hold } from '@dropdeck/shared';
import { ddb, getHold, isConditionFailure, table } from '@dropdeck/shared/ddb';
import { mailMode, sendMail } from './mailer.js';

/**
 * Email code at checkout (decisions 0001 and 0002). Sent only once a buyer holds stock, so the number of emails
 * is bounded by holds, not by the crowd. Every counter moves by a conditional update, so concurrent requests
 * cannot exceed the limits.
 */
export const OTP = { ttlMs: 10 * 60_000, resendAfterMs: 30_000, maxSends: 3, maxAttempts: 5 };

/** Keyed by hold, so a code is useless on any other hold even if it leaks. */
const codeHash = (key: string, holdId: string, code: string) => createHmac('sha256', key).update(`${holdId}:${code}`).digest('base64url');

const mask = (email: string) => email.replace(/^(.)[^@]*(.@)/, (_, a: string, b: string) => `${a}•••${b}`);

export async function sendCode(drop: Drop, hold: Hold, rawEmail: unknown, key: string, now: number) {
  if (drop.verification !== 'email') throw new ApiError('VALIDATION', 'This drop does not need an email code');
  if (drop.state === 'Cancelled') throw new ApiError('INVALID_STATE', 'This drop was cancelled by the merchant');
  if (hold.state !== 'active' || hold.expiresAt <= now) throw new ApiError('HOLD_EXPIRED', 'Your hold has expired');
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
  if (!isPlausibleEmail(email)) throw new ApiError('VALIDATION', 'Please enter a valid email');
  const normalised = normaliseEmail(email);

  // Refuse an address that already ordered before spending an email on it.
  const limit = await ddb.send(new GetCommand({ TableName: table(), Key: keys.buyerLimit(drop.tenantId, drop.dropId, emailHash(normalised, key)) }));
  if (limit.Item && limit.Item.holdId !== hold.holdId) throw new ApiError('LIMIT_REACHED', 'This email already has an order for this drop');

  const code = String(randomInt(1_000_000)).padStart(6, '0');
  try {
    await ddb.send(new UpdateCommand({
      TableName: table(),
      Key: keys.hold(drop.tenantId, drop.dropId, hold.holdId),
      UpdateExpression: 'SET otpHash = :h, otpEmail = :e, otpExpiresAt = :exp, otpLastSentAt = :now, otpSends = if_not_exists(otpSends, :zero) + :one',
      ConditionExpression: '#s = :active AND expiresAt > :now'
        + ' AND (attribute_not_exists(otpSends) OR otpSends < :max)'
        + ' AND (attribute_not_exists(otpLastSentAt) OR otpLastSentAt <= :resendFrom)',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: {
        ':h': codeHash(key, hold.holdId, code), ':e': normalised, ':exp': Math.min(now + OTP.ttlMs, hold.expiresAt),
        ':now': now, ':zero': 0, ':one': 1, ':active': 'active', ':max': OTP.maxSends, ':resendFrom': now - OTP.resendAfterMs,
      },
    }));
  } catch (e) {
    if (!isConditionFailure(e)) throw e;
    const current = await getHold(drop.tenantId, drop.dropId, hold.holdId);
    if (!current || current.state !== 'active' || current.expiresAt <= now) throw new ApiError('HOLD_EXPIRED', 'Your hold has expired');
    if ((current.otpSends ?? 0) >= OTP.maxSends) throw new ApiError('OTP_LOCKED', 'Too many codes sent for this hold');
    const wait = Math.ceil(((current.otpLastSentAt ?? now) + OTP.resendAfterMs - now) / 1000);
    throw new ApiError('RATE_LIMITED', 'Please wait before asking for another code', Math.max(1, wait));
  }

  await sendMail({
    to: email,
    subject: `Your code for ${drop.title}: ${code}`,
    text: `Your DropDeck code is ${code}.\n\nEnter it to confirm your order for "${drop.title}". It expires in 10 minutes or when your hold ends, whichever is sooner.\n\nIf you did not ask for this, ignore this email.`,
  });
  return {
    sentTo: mask(email),
    resendAfterSec: OTP.resendAfterMs / 1000,
    sendsLeft: OTP.maxSends - (hold.otpSends ?? 0) - 1,
    // Log mode (no email configured, dev and test stages): hand the code to the page so checkout can be tried.
    ...(mailMode() === 'log' ? { devCode: code } : {}),
  };
}

/**
 * Checks a submitted code. Returns the hash it matched so the confirm can require that same code to still be
 * current when it flips the hold. A wrong code costs one of OTP.maxAttempts, counted conditionally.
 */
export async function checkCode(drop: Drop, hold: Hold, rawEmail: string, rawCode: unknown, key: string, now: number): Promise<string> {
  if (!hold.otpHash || !hold.otpEmail) throw new ApiError('OTP_INVALID', 'Ask for a code first');
  if (normaliseEmail(rawEmail) !== hold.otpEmail) throw new ApiError('OTP_INVALID', 'Use the email address the code was sent to');
  if ((hold.otpAttempts ?? 0) >= OTP.maxAttempts) throw new ApiError('OTP_LOCKED', 'Too many wrong codes for this hold');
  if (now > (hold.otpExpiresAt ?? 0)) throw new ApiError('OTP_INVALID', 'That code has expired; ask for a new one');
  const code = typeof rawCode === 'string' ? rawCode.replace(/\s/g, '') : '';
  const given = Buffer.from(codeHash(key, hold.holdId, code));
  const expected = Buffer.from(hold.otpHash);
  if (given.length === expected.length && timingSafeEqual(given, expected)) return hold.otpHash;

  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: table(),
      Key: keys.hold(drop.tenantId, drop.dropId, hold.holdId),
      UpdateExpression: 'SET otpAttempts = if_not_exists(otpAttempts, :zero) + :one',
      ConditionExpression: 'attribute_not_exists(otpAttempts) OR otpAttempts < :max',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':max': OTP.maxAttempts },
      ReturnValues: 'UPDATED_NEW',
    }));
    const left = OTP.maxAttempts - Number(r.Attributes?.otpAttempts ?? OTP.maxAttempts);
    if (left <= 0) throw new ApiError('OTP_LOCKED', 'Too many wrong codes for this hold');
    throw new ApiError('OTP_INVALID', `That code is not right; ${left} ${left === 1 ? 'try' : 'tries'} left`);
  } catch (e) {
    if (isConditionFailure(e)) throw new ApiError('OTP_LOCKED', 'Too many wrong codes for this hold');
    throw e;
  }
}
