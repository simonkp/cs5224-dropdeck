import { describe, expect, it, vi } from 'vitest';
import { cachedSecret } from '../src/secrets.js';

describe('cachedSecret', () => {
  it('loads once per instance', async () => {
    const load = vi.fn().mockResolvedValue('k');
    const get = cachedSecret(load);
    await Promise.all([get(), get(), get()]);
    expect(load).toHaveBeenCalledOnce();
  });

  it('retries after a failed load instead of caching the failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('throttled')).mockResolvedValue('k');
    const get = cachedSecret(load);
    await expect(get()).rejects.toThrow('throttled');
    await expect(get()).resolves.toBe('k');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
