export function useWorkspaceVault() {
  const request = useState<{ workspaceId: string; jobId?: string } | null>('workspace-vault-dialog', () => null);
  return { request, open: (workspaceId: string, jobId?: string) => { request.value = { workspaceId, jobId }; } };
}
