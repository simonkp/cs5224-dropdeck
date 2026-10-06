'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { completeSignIn } from '../../../lib/auth';

/** Cognito managed login redirects here with ?code=…&state=… */
export default function Callback() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    completeSignIn(window.location.search)
      .then(() => window.location.replace('/m/'))
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      {error ? (
        <>
          <h1 className="font-display text-2xl font-extrabold">Sign-in didn&apos;t finish</h1>
          <p className="text-sm text-muted">{error}</p>
          <a href="/m/" className="font-bold underline underline-offset-4">Back to the console</a>
        </>
      ) : (
        <>
          <Loader2 className="size-8 animate-spin text-muted" />
          <h1 className="font-display text-xl font-bold">Signing you in…</h1>
        </>
      )}
    </main>
  );
}
