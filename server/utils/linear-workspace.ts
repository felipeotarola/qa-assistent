import { createError } from 'h3';
import type { LinearWorkspaceProject } from '../../shared/linear-workspace';
import type { Destination } from '../../shared/external';

export async function readLinearProject(token: string, destination: Destination, cursors: { issues?: string; documents?: string }, request: typeof fetch = fetch): Promise<LinearWorkspaceProject> {
  if (destination.provider !== 'linear' || !destination.projectId) throw createError({ statusCode: 400, statusMessage: 'Choose a Linear project in workspace connections.' });
  const response = await request('https://api.linear.app/graphql', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query WorkspaceProject($id: String!, $team: ID!, $issues: String, $documents: String) {
        project(id: $id) {
          id name description content url
          teams(first: 1, filter: { id: { eq: $team } }) { nodes { id } }
          issues(first: 50, after: $issues, filter: { team: { id: { eq: $team } } }, orderBy: updatedAt) {
            nodes { id identifier title description url updatedAt state { name } assignee { name } }
            pageInfo { hasNextPage endCursor }
          }
          documents(first: 20, after: $documents) {
            nodes { id title content url updatedAt }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      variables: { id: destination.projectId, team: destination.targetId, issues: cursors.issues, documents: cursors.documents },
    }),
  });
  if (!response.ok) throw createError({ statusCode: response.status === 401 || response.status === 403 ? 424 : 502, statusMessage: 'Could not read Linear. Check your connection and access.' });
  const result = await response.json() as { errors?: unknown[]; data?: { project?: LinearWorkspaceProject & { teams: { nodes: { id: string }[] } } } };
  if (result.errors?.length || !result.data?.project) throw createError({ statusCode: 502, statusMessage: 'Linear could not return the project. Check project access.' });
  const { teams, ...project } = result.data.project;
  // Linear accepts both UUIDs and MCP project identifiers (e.g. P-COM-8).
  // The project resolver fixes the selected project; independently verify its team.
  if (!teams.nodes.some(team => team.id === destination.targetId)) throw createError({ statusCode: 403, statusMessage: 'Project is outside the workspace destination.' });
  return project;
}
