import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
function key() {
  const secret = process.env.ENV_VAULT_KEY || process.env.OAUTH_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('Environment vault encryption is not configured');
  return Buffer.from(hkdfSync('sha256', secret, 'pat-environment-v1', 'repository-test-environments', 32));
}
export function sealEnvironment(values: Record<string, string>, scope: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(scope));
  const data = Buffer.concat([cipher.update(JSON.stringify(values)), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
export function openEnvironment(value: string, scope: string): Record<string, string> {
  const [version, iv, tag, data] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Invalid environment vault entry');
  const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8'));
}
