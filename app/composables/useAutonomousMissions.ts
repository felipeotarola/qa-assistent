import type { Ref } from 'vue';
import type { MissionAllowedAction, MissionDetailPresentation, MissionPresentation } from '#shared/mission-presentation';
import type { MissionControlAction, MissionWaitAnswer } from '#shared/mission-control';

type ControlInput = Exclude<MissionControlAction, { action: 'accept' }>;
type Command = { action: MissionAllowedAction } | { action: 'answer'; waitId: string; answer: MissionWaitAnswer };
type Operation = { workspaceId: string; threadId: string; input: ControlInput; state: 'sending' | 'uncertain' };
type List = { workspaceId: string; missions: MissionPresentation[]; hasMore: boolean };
const operationKey = (workspaceId: string, missionId: string) => `${workspaceId}:${missionId}`;

/** One explicit user command, including retries after an uncertain response.
 * Reading status never resends it; retries retain the original mandate/body/ID. */
export function createMissionControlClient(options: {
  request: (url: string, options: { method: 'POST'; body: { threadId: string; input: ControlInput }; retry: 0 }) => Promise<unknown>;
  refresh: (workspaceId: string) => Promise<unknown>;
  operations: Ref<Record<string, Operation>>; notices: Ref<Record<string, string>>; makeId: () => string;
}) {
  const key = operationKey;
  async function refresh(workspaceId: string) { try { await options.refresh(workspaceId); } catch { /* The read view exposes its own error. */ } }
  async function send(operation: Operation) {
    const id = key(operation.workspaceId, operation.input.missionId);
    options.operations.value[id] = { ...operation, state: 'sending' }; options.notices.value[id] = '';
    try {
      await options.request(`/api/workspaces/${operation.workspaceId}/autonomy`, { method: 'POST', retry: 0, body: { threadId: operation.threadId, input: operation.input } });
      Reflect.deleteProperty(options.operations.value, id);
      await refresh(operation.workspaceId);
      return true;
    } catch (error) {
      const failure = error as { statusCode?: number; status?: number; response?: { status?: number } } | null | undefined;
      const status = failure?.statusCode ?? failure?.status ?? failure?.response?.status;
      if (status && [400, 401, 403, 404, 409, 422].includes(status)) {
        Reflect.deleteProperty(options.operations.value, id);
        options.notices.value[id] = status === 409 ? 'Uppdragets status har ändrats. Läs den uppdaterade statusen innan du väljer nästa åtgärd.' : 'Åtgärden kunde inte genomföras. Läs den uppdaterade statusen.';
      } else {
        options.operations.value[id] = { ...operation, state: 'uncertain' };
        options.notices.value[id] = 'Svaret kunde inte bekräftas. Åtgärden kan ha genomförts. Hämta status eller skicka samma begäran igen.';
      }
      await refresh(operation.workspaceId);
      return false;
    }
  }
  return {
    async command(workspaceId: string, mission: MissionPresentation, command: Command) {
      const id = key(workspaceId, mission.id);
      if (options.operations.value[id]) return false;
      if (command.action === 'answer') {
        const wait = mission.waits.find(wait => wait.id === command.waitId);
        if (!wait || wait.status !== 'waiting' || !wait.allowedAnswers.includes(command.answer.kind)) return false;
      } else if (!mission.allowedActions.includes(command.action)) return false;
      const input = structuredClone({ ...command, missionId: mission.id, expectedMandateRevision: mission.mandateRevision, requestId: options.makeId(),
        ...(['pause', 'cancel'].includes(command.action) ? { reason: '' } : {}) }) as ControlInput;
      return send({ workspaceId, threadId: mission.threadId, input, state: 'sending' });
    },
    async retry(workspaceId: string, missionId: string) {
      const operation = options.operations.value[key(workspaceId, missionId)];
      return operation?.state === 'uncertain' ? send(operation) : false;
    },
  };
}

export function useAutonomousMissions(polling = false) {
  const { activeId } = useWorkspaces(), request = useRequestFetch();
  const state = useAsyncData(() => `autonomous-missions-${activeId.value}`, async (): Promise<List> => {
    const workspaceId = activeId.value;
    if (!workspaceId) return { workspaceId: '', missions: [], hasMore: false };
    const result = await request<{ missions: MissionPresentation[]; hasMore: boolean }>(`/api/workspaces/${workspaceId}/autonomy`);
    return { ...result, workspaceId };
  });
  // Workspace switches must not flash a previous workspace's mission or answer.
  const data = computed(() => state.data.value?.workspaceId === activeId.value ? state.data.value : undefined);
  const operations = useState<Record<string, Operation>>('autonomous-mission-commands', () => ({}));
  const notices = useState<Record<string, string>>('autonomous-mission-notices', () => ({}));
  const details = useState<Record<string, MissionDetailPresentation>>('autonomous-mission-details', () => ({}));
  const detailPending = useState<Record<string, boolean>>('autonomous-mission-detail-pending', () => ({}));
  const detailErrors = useState<Record<string, string>>('autonomous-mission-detail-errors', () => ({}));
  const client = createMissionControlClient({ request: (url, options) => $fetch(url, options), operations, notices,
    makeId: () => crypto.randomUUID(), refresh: async workspaceId => { if (activeId.value === workspaceId) await state.refresh(); } });
  async function loadDetails(workspaceId: string, missionId: string) {
    const id = operationKey(workspaceId, missionId);
    if (detailPending.value[id]) return;
    detailPending.value[id] = true; detailErrors.value[id] = '';
    try { details.value[id] = await request<MissionDetailPresentation>(`/api/workspaces/${workspaceId}/autonomy/${missionId}`); }
    catch { detailErrors.value[id] = 'Uppdragets mätvärden kunde inte hämtas.'; }
    finally { detailPending.value[id] = false; }
  }
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  async function poll() {
    if (disposed) return;
    try {
      if (document.visibilityState === 'visible' && activeId.value) {
        const workspaceId = activeId.value;
        await state.refresh();
        if (disposed || document.visibilityState !== 'visible' || activeId.value !== workspaceId) return;
        // Refresh telemetry that the user has requested, including failed first
        // reads. Both card locations share this cache and in-flight guard.
        await Promise.all((data.value?.missions ?? []).filter(mission => {
          const id = operationKey(workspaceId, mission.id);
          return details.value[id] || detailErrors.value[id];
        }).map(mission => loadDetails(workspaceId, mission.id)));
      }
    }
    catch { /* The view exposes the failed read; polling does not drive work. */ }
    finally { if (!disposed) timer = setTimeout(poll, 7000); }
  }
  onMounted(() => { if (polling) timer = setTimeout(poll, 7000); });
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
  return { data, error: state.error, pending: state.pending, refresh: state.refresh, ...client, loadDetails,
    operation: (workspaceId: string, missionId: string) => operations.value[operationKey(workspaceId, missionId)],
    notice: (workspaceId: string, missionId: string) => notices.value[operationKey(workspaceId, missionId)] ?? '',
    detail: (workspaceId: string, missionId: string) => details.value[operationKey(workspaceId, missionId)],
    detailLoading: (workspaceId: string, missionId: string) => !!detailPending.value[operationKey(workspaceId, missionId)],
    detailError: (workspaceId: string, missionId: string) => detailErrors.value[operationKey(workspaceId, missionId)] ?? '',
  };
}
