import { createHash, createHmac } from 'node:crypto';

export function sandboxScope(userId: string, threadId: string, sessionKey: string) {
  const scope = `${userId}:${threadId}:${sessionKey}`;
  const hex = createHash('sha256').update(scope).digest('hex');
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
    owner: createHmac('sha256', process.env.INTERNAL_API_SECRET!).update(scope).digest('hex'),
  };
}
