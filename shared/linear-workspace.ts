export interface LinearPage<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
export interface LinearWorkspaceIssue {
  id: string; identifier: string; title: string; description: string | null; url: string; updatedAt: string;
  state: { name: string }; assignee: { name: string } | null;
}
export interface LinearWorkspaceDocument { id: string; title: string; content: string | null; url: string; updatedAt: string }
export interface LinearWorkspaceProject {
  id: string; name: string; description: string; content: string | null; url: string;
  issues: LinearPage<LinearWorkspaceIssue>; documents: LinearPage<LinearWorkspaceDocument>;
}
