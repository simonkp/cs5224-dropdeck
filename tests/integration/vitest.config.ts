import { defineConfig } from 'vitest/config';

/**
 * Runs the real handlers in-process against DynamoDB Local, so conditional writes are evaluated by a real
 * engine rather than a mock. Skipped unless DYNAMODB_LOCAL is set; `pnpm test:int` at the root starts one.
 */
const endpoint = process.env.DYNAMODB_LOCAL;

export default defineConfig({
  test: {
    testTimeout: 60_000,
    env: endpoint
      ? {
          AWS_ENDPOINT_URL_DYNAMODB: endpoint,
          AWS_REGION: 'ap-southeast-1',
          AWS_ACCESS_KEY_ID: 'local',
          AWS_SECRET_ACCESS_KEY: 'local',
          TOKEN_KEY_PARAM: 'literal:integration-token-key',
          EMAIL_HASH_KEY_PARAM: 'literal:integration-email-key',
          BUCKET_NAME: 'unused-in-tests',
        }
      : {},
  },
});
