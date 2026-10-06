import { toast } from 'sonner';

/** The phone's share sheet where there is one; otherwise copy the link. */
export async function shareLink(url: string, title: string): Promise<void> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  await copyText(url, 'Link copied');
}

export async function copyText(text: string, done = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error('Could not copy. Press and hold to copy instead.');
  }
}
