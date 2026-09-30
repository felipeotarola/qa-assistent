export interface SandboxState {
  id: string;
  workspaceId: string;
  status: 'starting' | 'ready' | 'waiting' | 'blocked' | 'stopped' | 'deleted' | 'expired';
  message: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  processes: { id: string; status: string; stdout: string; stderr: string; exitCode: number | null }[];
}
