import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { s3Keys, type PublicState } from '@dropdeck/shared';

const s3 = new S3Client({});

/** state.json is what every waiting buyer polls through CloudFront (cached 1–5 s). */
export async function writeState(t: string, d: string, state: PublicState): Promise<void> {
  const bucket = process.env.BUCKET_NAME;
  if (!bucket) throw new Error('Missing env BUCKET_NAME');
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: s3Keys.stateJson(t, d),
    Body: JSON.stringify(state),
    ContentType: 'application/json',
    CacheControl: 'public, max-age=2',
  }));
}
