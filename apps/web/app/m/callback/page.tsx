'use client';

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
    <main>
      <h1>Signing in…</h1>
      {error && (
        <p className="error">
          {error} <a href="/m/">Back to the console</a>
        </p>
      )}
    </main>
  );
}
