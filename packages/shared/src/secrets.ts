import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * Signing keys live in SSM SecureStrings (scripts/put-secrets.sh); CloudFormation cannot create them.
 * Exported from `@dropdeck/shared/secrets`, not the index, so the web bundle never pulls in the SDK.
 */

/** Memoise an async loader for the life of the Lambda instance; a failed load is retried next call. */
export function cachedSecret(load: () => Promise<string>): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= load().catch((e: unknown) => {
      pending = undefined;
      throw e;
    });
    return pending;
  };
}

let ssm: SSMClient | undefined;

/**
 * Reads the SecureString named by env var `envName` (e.g. TOKEN_KEY_PARAM).
 * `literal:<value>` skips SSM; for tests and local runs only (the stack always sets a parameter name).
 */
export function ssmSecret(envName: string): () => Promise<string> {
  return cachedSecret(async () => {
    const name = process.env[envName];
    if (!name) throw new Error(`Missing env ${envName}`);
    if (name.startsWith('literal:')) return name.slice('literal:'.length);
    ssm ??= new SSMClient({});
    const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = r.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter ${name} is empty`);
    return value;
  });
}
