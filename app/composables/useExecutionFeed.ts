import type { ExecutionEvent } from '#shared/execution';
import type { RepoJob } from '#shared/repository';
import type { SandboxState } from '#shared/sandbox';
import type { SetupView } from '#shared/project-environment';

// Mounted once by the application shell. All cards consume these shared values.
export function useExecutionFeed() {
  const { activeId, refresh, data } = useRepositoryRuns();
  const jobs = useState<Record<string, RepoJob>>('execution-jobs', () => ({}));
  const sandboxes = useState<SandboxState[]>('execution-sandboxes', () => []);
  const setups = useState<{ workspaceId: string; jobs: SetupView[] }>('execution-setups', () => ({ workspaceId: '', jobs: [] }));
  const browserEvent = useState<ExecutionEvent | null>('execution-browser', () => null);
  const connected = useState<Record<string, boolean>>('execution-connected', () => ({}));
  const sources = new Map<string, { source: EventSource; expiresAt: number }>();
  const browserId = useState<string | null>('execution-browser-id', () => null);
  let subscribed = '';
  let failures = 0;
  const seen = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = true, generation = 0;
  function close() { for (const item of sources.values()) item.source.close(); sources.clear(); connected.value = {}; }
  async function poll() {
    if (stopped) return;
    const current = generation, workspaceId = activeId.value;
    try {
      if (workspaceId && !document.hidden) {
        await refresh();
        const [sandboxResult,setupResult] = await Promise.all([
          $fetch<{ sessions: SandboxState[] }>(`/api/workspaces/${workspaceId}/sandboxes`).catch(() => null),
          $fetch<{workspaceId:string;jobs:SetupView[]}>(`/api/workspaces/${workspaceId}/setup-jobs`).catch(() => null),
        ]);
        if (current !== generation || stopped) return;
        if (sandboxResult) sandboxes.value = sandboxResult.sessions;
        if (setupResult) setups.value = setupResult;
        const signature = `${browserId.value}:${data.value?.runs.map(run => run.id).join(',')}:${sandboxes.value.map(s => s.id).join(',')}`;
        if (signature !== subscribed || !sources.size || [...sources.values()].some(s => s.expiresAt - Date.now() < 30000)) {
          const { streams } = await $fetch<{ streams: { kind: string; url: string; expiresAt: number }[] }>(`/api/workspaces/${workspaceId}/execution-subscriptions`, { method: 'POST' });
          if (current !== generation || stopped) return;
          close();
          subscribed = signature;
          for (const stream of streams) {
            const source = new EventSource(stream.url);
            sources.set(stream.kind, { source, expiresAt: stream.expiresAt });
            source.onopen = () => { if (current === generation) connected.value = { ...connected.value, [stream.kind]: true }; };
            source.onerror = () => { if (current === generation) connected.value = { ...connected.value, [stream.kind]: false }; };
            source.onmessage = event => {
              if (current !== generation) return;
              try {
                const value = JSON.parse(event.data) as ExecutionEvent;
                if (value.version !== 1 || !Number.isSafeInteger(value.seq) || (seen.get(value.executionId) || 0) >= value.seq) return;
                seen.set(value.executionId, value.seq);
                if (value.kind === 'repository') {
                  const job = value.snapshot as RepoJob;
                  jobs.value = { ...jobs.value, [value.executionId]: job };
                  if (data.value) data.value = { ...data.value, runs: data.value.runs.map(run => run.id === value.executionId ? { ...run, job } : run) };
                }
                else if (value.kind === 'browser') browserEvent.value = value;
                else if (value.kind === 'sandbox') {
                  const snapshot = value.snapshot as SandboxState;
                  sandboxes.value = sandboxes.value.filter(s => s.id !== snapshot.id);
                  if (!['deleted', 'expired'].includes(snapshot.status)) sandboxes.value.push(snapshot);
                }
              } catch { /* Invalid event cannot replace the last known state. */ }
            };
          }
        }
      }
      failures = 0;
    } catch { failures = Math.min(failures + 1, 4); }
    finally { if (!stopped && current === generation) timer = setTimeout(() => { void poll().catch(() => {}); }, Math.min(30000, 4000 * 2 ** failures)); }
  }
  watch(activeId, () => {
    generation++; close(); subscribed = ''; failures = 0; seen.clear(); jobs.value = {}; browserEvent.value = null; sandboxes.value = []; setups.value = {workspaceId:'',jobs:[]};
    clearTimeout(timer); if (!stopped) void poll().catch(() => {});
  });
  onMounted(() => { stopped = false; void poll().catch(() => {}); });
  onBeforeUnmount(() => { stopped = true; generation++; clearTimeout(timer); close(); });
}
