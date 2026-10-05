import { ApiError } from './errors.js';

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const base = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const json = (statusCode: number, body: unknown): HttpResult => ({ statusCode, headers: base, body: JSON.stringify(body) });

export function errorResult(err: unknown): HttpResult {
  if (err instanceof ApiError) return json(err.status, err.toBody());
  console.error(JSON.stringify({ level: 'error', msg: String(err), stack: (err as Error)?.stack }));
  return json(500, { code: 'INTERNAL', message: 'Unexpected error' });
}

export function parseBody<T>(raw: string | undefined | null, isBase64?: boolean): T {
  if (!raw) throw new ApiError('VALIDATION', 'Missing body');
  try {
    return JSON.parse(isBase64 ? Buffer.from(raw, 'base64').toString() : raw) as T;
  } catch {
    throw new ApiError('VALIDATION', 'Body is not valid JSON');
  }
}
