// Bound model context without truncating the authoritative saved run or UI logs.
export function repositoryContext(value) {
  if (!value || typeof value !== 'object') return value;
  const executionNotice = 'Repository jobs are bounded checks in disposable environments, not app startup. Installation/build success does not prove a running service. For a live app use the Eve bash sandbox, verify HTTP, then preview; the checkout from this job is not shared with that sandbox.';
  let remaining = 6000;
  const jobContext = (job) => {
    if (!job) return null;
    const logs = typeof job.logs === 'string' ? job.logs : '';
    const allowance = Math.min(2000, remaining);
    const tail = allowance ? logs.slice(-allowance) : '';
    remaining -= tail.length;
    return { ...job, executionNotice, logs: tail, logsTruncated: tail.length < logs.length,
      ...(tail.length < logs.length ? { logNotice: 'Only a log tail is included. Full logs are saved in the workspace execution card; omitted output is not evidence of success or failure.' } : {}) };
  };
  if (Array.isArray(value.runs)) return {
    available: value.available, syncError: value.syncError,
    repositories: value.repositories?.map(({ id, url, ref, script }) => ({ id, url, ref, script })),
    runs: value.runs.map(({ id, repositoryId, createdAt, job }) => ({ id, repositoryId, createdAt, job: jobContext(job) })),
  };
  return typeof value.logs === 'string' ? jobContext(value) : value;
}
