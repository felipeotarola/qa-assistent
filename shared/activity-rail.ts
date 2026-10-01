export function activityRailState(statuses: string[]) {
  // A running worker and a completed command never imply a passing test.
  const status = statuses.some(s => ['needs_configuration', 'blocked', 'dispatch_unknown', 'waiting', 'human_control'].includes(s)) ? 'waiting'
    : statuses.some(s => ['queued', 'starting', 'running', 'preparing', 'installing', 'cleaning', 'configuring', 'working'].includes(s)) ? 'working'
      : statuses.some(s => ['failed', 'error', 'timeout', 'interrupted'].includes(s)) ? 'error' : 'idle';
  return { status, detail: { working: 'Arbete pågår', waiting: 'Behöver din uppmärksamhet', error: 'Problem rapporterat', idle: 'Visa senaste aktivitet' }[status] } as const;
}
