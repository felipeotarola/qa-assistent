export async function readJson(req, limit = 8192) {
  let size = 0; const parts = [];
  for await (const part of req) { size += part.length; if (size > limit) throw new Error('Request too large'); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
const defaultOrigins = 'http://localhost:3000,http://127.0.0.1:3000,https://qa-assistent.vercel.app,https://qa.felipeotarola.com';

export function allowedOrigins(configured = process.env.EXECUTION_ORIGINS) {
  const origins = (configured ?? defaultOrigins).split(',').map(value => value.trim()).filter(Boolean);
  return [...new Set(origins.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) throw new Error('EXECUTION_ORIGINS must contain exact HTTP(S) origins');
    return url.origin;
  }))];
}

export const frameAncestorsPolicy = () => `frame-ancestors ${allowedOrigins().join(' ') || "'none'"}`;
