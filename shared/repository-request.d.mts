export function repositoryRequestId(threadId: string, callId: string): string;
interface RepositoryRequestIdentity {
  repositoryId: string;
  runtime: string | null;
  bindingVersion?: number | null;
  config: object;
  missionBinding?: { missionId: string; taskId: string } | null;
}
export function repositoryRequestMatches(run: RepositoryRequestIdentity, request: RepositoryRequestIdentity): boolean;
