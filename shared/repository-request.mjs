import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// A replay of the same Eve tool call must reuse its submission ID. A new call
// must not collide with another run because a model supplied a placeholder UUID.
export function repositoryRequestId(threadId, callId) {
  if (!threadId || !callId) throw new Error('Repository submission requires a thread and tool call ID');
  const hex = createHash('sha256').update(JSON.stringify([threadId, callId])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Execution ownership is immutable. Attaching a historical source to another
// report is a separate action and must never rebind a start/replay identity.
export function repositoryRequestMatches(run, request) {
  return run.repositoryId === request.repositoryId
    && run.runtime === request.runtime
    && run.bindingVersion === request.bindingVersion
    && isDeepStrictEqual(run.config, request.config)
    && isDeepStrictEqual(run.missionBinding ?? null, request.missionBinding ?? null);
}
