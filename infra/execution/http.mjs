export async function readJson(req, limit = 8192) {
  let size = 0; const parts = [];
  for await (const part of req) { size += part.length; if (size > limit) throw new Error('Request too large'); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
export const allowedOrigins = () => (process.env.EXECUTION_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,https://qa-assistent.vercel.app').split(',');
