import type { Ref } from 'vue';
import { toRaw } from 'vue';
import type { EnvironmentConsentStatus, EnvironmentConsentView } from '#shared/project-environment-consent';

type GrantBody = { requestId: string; expectedPlanHash: string; expectedVaultRevision: number; allowedNames: string[]; expiresAt: string };
type PendingGrant = { body: GrantBody; plan: NonNullable<EnvironmentConsentStatus['plan']>; state: 'sending' | 'uncertain' };
export type EnvironmentConsentState = { status: EnvironmentConsentStatus | null; loading: boolean; generation: number; notice: string; pending?: PendingGrant; granted?: EnvironmentConsentView };
const keyOf = (workspaceId: string, jobId: string) => `${workspaceId}:${jobId}`;

export function usableEnvironmentConsent(consent: EnvironmentConsentView, status: EnvironmentConsentStatus | null, now: number) {
  return !!status?.plan && consent.status === 'active' && !consent.revokedAt && Date.parse(consent.expiresAt) > now
    && consent.planHash === status.planHash && consent.vaultRevision === status.vaultRevision && consent.repoUrl === status.plan.repoUrl
    && consent.allowedNames.every(name => status.configuredNames.includes(name) && status.plan!.variables.some(variable => variable.name === name))
    && status.plan.variables.every(variable => !variable.required || consent.allowedNames.includes(variable.name));
}

/** Reads never grant or resume. Uncertain POSTs retain the original full body,
 * including expiry and request ID, even after closing/reopening the panel. */
export function createEnvironmentConsentClient(options: {
  states: Ref<Record<string, EnvironmentConsentState>>; makeId: () => string; now: () => number;
  read: (url: string, options: { retry: 0 }) => Promise<EnvironmentConsentStatus>;
  post: (url: string, options: { method: 'POST'; retry: 0; body: GrantBody }) => Promise<EnvironmentConsentView>;
}) {
  const state = (workspaceId: string, jobId: string) => {
    const key = keyOf(workspaceId, jobId);
    options.states.value[key] ||= { status: null, loading: false, generation: 0, notice: '' };
    // Assignment returns the raw newly created object. Read it back through Vue
    // so the first asynchronous response notifies renders and status watchers.
    return options.states.value[key]!;
  };
  const url = (workspaceId: string, jobId: string) => `/api/workspaces/${workspaceId}/setup-jobs/${jobId}/consent`;
  async function load(workspaceId: string, jobId: string) {
    const entry = state(workspaceId, jobId), generation = ++entry.generation;
    entry.loading = true;
    try {
      const result = await options.read(url(workspaceId, jobId), { retry: 0 });
      if (entry.generation !== generation) return false;
      if (result.setupJobId !== jobId) throw new Error('Unexpected setup job');
      entry.status = result; return true;
    } catch {
      if (entry.generation === generation) { entry.status = null; entry.notice = 'Startplanen kunde inte hämtas. Hämta aktuell status innan du godkänner.'; }
      return false;
    } finally { if (entry.generation === generation) entry.loading = false; }
  }
  async function send(workspaceId: string, jobId: string, pending: PendingGrant) {
    const entry = state(workspaceId, jobId);
    entry.pending = { ...pending, state: 'sending' }; entry.notice = '';
    let saved: EnvironmentConsentView;
    try { saved = await options.post(url(workspaceId, jobId), { method: 'POST', retry: 0, body: structuredClone(toRaw(pending.body)) }); }
    catch (error) {
      const failure = error as { statusCode?: number; status?: number; response?: { status?: number } } | null | undefined;
      const status = failure?.statusCode ?? failure?.status ?? failure?.response?.status;
      if (status && [400, 401, 403, 404, 409, 422].includes(status)) {
        entry.pending = undefined;
        entry.notice = status === 409 ? 'Startplanen eller Vault har ändrats. Läs den aktuella planen och godkänn på nytt.' : 'Medgivandet kunde inte sparas. Kontrollera aktuell status.';
        await load(workspaceId, jobId);
      } else {
        entry.pending = { ...pending, state: 'uncertain' };
        entry.notice = 'Svaret kunde inte bekräftas. Medgivandet kan vara sparat. Försök med samma begäran för att få kvittot.';
      }
      return null;
    }
    entry.pending = undefined; entry.granted = saved;
    // The grant is confirmed even if this read fails; never retry it as a new
    // grant. The user can read and select the persisted receipt afterwards.
    if (!await load(workspaceId, jobId)) return null;
    if (!usableEnvironmentConsent(saved, entry.status, options.now())) {
      entry.notice = 'Medgivandet gäller inte längre den aktuella planen. Läs status innan du fortsätter.'; return null;
    }
    return saved;
  }
  return { state, load,
    async grant(workspaceId: string, jobId: string, allowedNames: string[], hours = 24) {
      const entry = state(workspaceId, jobId), status = entry.status;
      if (entry.pending || entry.loading || !status?.plan || !status.planHash || status.vaultRevision < 1 || ![1, 24, 168].includes(hours)) return null;
      const names = [...new Set(allowedNames)].sort();
      if (!names.length || names.some(name => !status.configuredNames.includes(name) || !status.plan!.variables.some(variable => variable.name === name))
        || status.plan.variables.some(variable => variable.required && !names.includes(variable.name))) return null;
      const pending: PendingGrant = { state: 'sending', plan: structuredClone(toRaw(status.plan)), body: {
        requestId: options.makeId(), expectedPlanHash: status.planHash, expectedVaultRevision: status.vaultRevision,
        allowedNames: names, expiresAt: new Date(options.now() + hours * 60 * 60 * 1000).toISOString(),
      } };
      return send(workspaceId, jobId, pending);
    },
    async retry(workspaceId: string, jobId: string) {
      const pending = state(workspaceId, jobId).pending;
      return pending?.state === 'uncertain' ? send(workspaceId, jobId, pending) : null;
    },
  };
}

export function useEnvironmentConsent() {
  const states = useState<Record<string, EnvironmentConsentState>>('environment-consent-controls', () => ({}));
  return createEnvironmentConsentClient({ states, makeId: () => crypto.randomUUID(), now: () => Date.now(),
    read: (url, options) => $fetch(url, options), post: (url, options) => $fetch(url, options) });
}
