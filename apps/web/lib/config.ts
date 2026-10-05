/** Written by the CDK stack at deploy time; for `next dev`, copy a deployed one into public/config.json. */
export interface RuntimeConfig {
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  /** Cognito managed-login base URL, e.g. https://dropdeck-dev-x.auth.ap-southeast-1.amazoncognito.com */
  authDomain: string;
  stage: string;
}

let pending: Promise<RuntimeConfig> | undefined;

export function loadConfig(): Promise<RuntimeConfig> {
  pending ??= fetch('/config.json', { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<RuntimeConfig>) : Promise.reject(new Error('Missing /config.json'))))
    .catch((e: unknown) => {
      pending = undefined;
      throw e;
    });
  return pending;
}
