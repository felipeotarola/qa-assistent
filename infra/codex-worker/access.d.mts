export type CodexAccess = { mode: 'shared' } | { mode: 'pilot'; pilotUserId: string } | { mode: 'disabled' };
export function resolveCodexAccess(mode?: string, pilotUserId?: string): CodexAccess;
export function canUseCodex(userId: unknown, access: CodexAccess): boolean;
