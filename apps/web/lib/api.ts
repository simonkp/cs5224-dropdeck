import { getAccessToken } from './auth';
import { loadConfig } from './config';

/** Error body shape from packages/shared/src/errors.ts. */
export class ApiRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/** Calls the merchant API with the signed-in user's token. 401 means the session ended. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const [cfg, token] = await Promise.all([loadConfig(), getAccessToken()]);
  if (!token) throw new ApiRequestError(401, 'UNAUTHORIZED', 'Please sign in again.');
  const r = await fetch(`${cfg.apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (r.status === 204) return undefined as T;
  const body = (await r.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (!r.ok) throw new ApiRequestError(r.status, body?.code ?? 'HTTP_ERROR', body?.message ?? `Request failed (${r.status})`);
  return body as T;
}
