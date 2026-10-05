const userIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

// Shared capacity never means shared ownership. Callers still pass through
// app authentication, the private runner API and sandbox/job ownership checks.
export function resolveCodexAccess(mode, pilotUserId) {
  const configured = typeof mode === 'string' ? mode.trim() : '';
  const pilot = typeof pilotUserId === 'string' && userIdPattern.test(pilotUserId) ? pilotUserId : undefined;
  if (configured === 'shared') return { mode: 'shared' };
  if ((!configured || configured === 'pilot') && pilot) return { mode: 'pilot', pilotUserId: pilot };
  return { mode: 'disabled' };
}

export function canUseCodex(userId, access) {
  return typeof userId === 'string' && userIdPattern.test(userId)
    && (access?.mode === 'shared' || (access?.mode === 'pilot' && userId === access.pilotUserId));
}
