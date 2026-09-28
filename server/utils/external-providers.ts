import { createMCPClient } from "@ai-sdk/mcp";
import type { Destination, DestinationOption, ExternalInput, ExternalIssue } from "../../shared/external";

export class ExternalServiceError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; }
}
export interface ExternalAdapter {
  destinations(cursor?: string): Promise<{ options: DestinationOption[]; cursor?: string }>;
  projects(teamId: string, cursor?: string): Promise<{ options: DestinationOption[]; cursor?: string }>;
  validate(targetId: string, projectId?: string): Promise<Destination>;
  list(destination: Destination, cursor?: string): Promise<{ issues: ExternalIssue[]; cursor?: string }>;
  read(destination: Destination, id: string): Promise<ExternalIssue>;
  write(destination: Destination, input: ExternalInput): Promise<ExternalIssue>;
  close(): Promise<void>;
}
type RecordData = Record<string, unknown>;
const record = (v: unknown): RecordData => v && typeof v === "object" ? v as RecordData : {};
const str = (v: unknown) => typeof v === "string" ? v : "";
const rows = (v: unknown) => Array.isArray(v) ? v.map(record) : [];
const required = (value: string, message: string) => { if (!value) throw new ExternalServiceError(502, message); return value; };

export function githubAdapter(token: string, request: typeof fetch = fetch): ExternalAdapter {
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await request(`https://api.github.com${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "personal-agent-template" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ExternalServiceError(response.status === 401 || response.status === 403 ? 403 : 502, `GitHub returned ${response.status}. Check the connection and repository access.`);
    return response.json() as Promise<unknown>;
  }
  const repo = (id: string) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) throw new ExternalServiceError(400, "Invalid repository");
    return `/repos/${id}`;
  };
  const number = (id: string) => { if (!/^[1-9]\d*$/.test(id)) throw new ExternalServiceError(400, "Use the issue number"); return id; };
  const page = (cursor?: string) => { if (cursor && !/^[1-9]\d{0,5}$/.test(cursor)) throw new ExternalServiceError(400, "Invalid page"); return Number(cursor || 1); };
  const issue = (data: unknown): ExternalIssue => {
    const r = record(data);
    return { id: String(r.number ?? r.id ?? ""), title: str(r.title), body: str(r.body), url: required(str(r.html_url), "GitHub did not return a result URL"), state: str(r.state) };
  };
  const read = async (d: Destination, id: string) => {
    const r = record(await api(`${repo(d.targetId)}/issues/${number(id)}`));
    if (r.pull_request) throw new ExternalServiceError(400, "This tool handles issues, not pull requests");
    return issue(r);
  };
  return {
    async destinations(cursor) {
      const p = page(cursor);
      const data = rows(await api(`/user/repos?per_page=100&sort=full_name&page=${p}`));
      return { options: data.map(r => ({ id: str(r.full_name), label: str(r.full_name) })), ...(data.length === 100 ? { cursor: String(p + 1) } : {}) };
    },
    async projects() { return { options: [] }; },
    async validate(id, projectId) {
      if (projectId) throw new ExternalServiceError(400, "GitHub destination is a repository");
      const r = record(await api(repo(id)));
      if (r.archived || r.has_issues === false) throw new ExternalServiceError(400, "Choose an active repository with issues enabled");
      return { provider: "github", targetId: required(str(r.full_name), "Repository unavailable"), label: str(r.full_name) };
    },
    async list(d, cursor) {
      const p = page(cursor);
      const data = rows(await api(`${repo(d.targetId)}/issues?state=all&per_page=50&page=${p}`));
      return { issues: data.filter(r => !r.pull_request).map(issue), ...(data.length === 50 ? { cursor: String(p + 1) } : {}) };
    },
    read,
    async write(d, input) {
      const base = repo(d.targetId);
      if (input.action === "create") return issue(await api(`${base}/issues`, "POST", { title: input.title, body: input.body ?? "" }));
      await read(d, input.issueId!);
      if (input.action === "comment") {
        const result = issue(await api(`${base}/issues/${number(input.issueId!)}/comments`, "POST", { body: input.body }));
        return { ...result, title: `Comment on #${input.issueId}` };
      }
      return issue(await api(`${base}/issues/${number(input.issueId!)}`, "PATCH", { ...(input.title === undefined ? {} : { title: input.title }), ...(input.body === undefined ? {} : { body: input.body }) }));
    },
    async close() {},
  };
}

export type LinearCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export function linearAdapter(call: LinearCall, close: () => Promise<void> = async () => {}): ExternalAdapter {
  const collection = async (name: string, key: string, args: Record<string, unknown>) => {
    const data = await call(name, args);
    const r = record(data);
    const list = Array.isArray(data) ? rows(data) : rows(r[key]);
    // Fail visibly when the upstream response shape changes, rather than claim
    // a valid connection has no data or invent a successful write.
    if (!Array.isArray(data) && !Array.isArray(r[key])) throw new ExternalServiceError(502, "Unexpected Linear response");
    return { list, ...(r.hasNextPage === true && typeof r.cursor === "string" ? { cursor: r.cursor } : {}) };
  };
  const issue = (data: unknown): ExternalIssue => {
    const r = record(data);
    return { id: required(str(r.id), "Linear returned no issue ID"), title: str(r.title), body: str(r.description), url: required(str(r.url), "Linear returned no issue URL"), state: str(r.status) };
  };
  const read = async (d: Destination, id: string) => {
    const r = record(await call("get_issue", { id }));
    const teamId = str(r.teamId) || str(record(r.team).id);
    const projectId = str(r.projectId) || str(record(r.project).id);
    if (teamId !== d.targetId || (d.projectId && projectId !== d.projectId)) throw new ExternalServiceError(403, "Issue is outside the selected Linear destination, or its scope could not be verified");
    return issue(r);
  };
  return {
    async destinations(cursor) {
      const result = await collection("list_teams", "teams", { limit: 100, ...(cursor ? { cursor } : {}) });
      return { options: result.list.map(r => ({ id: str(r.id), label: str(r.name) })), cursor: result.cursor };
    },
    async projects(teamId, cursor) {
      const result = await collection("list_projects", "projects", { team: teamId, limit: 50, ...(cursor ? { cursor } : {}) });
      return { options: result.list.map(r => ({ id: str(r.id), label: str(r.name) })), cursor: result.cursor };
    },
    async validate(targetId, projectId) {
      const team = record(await call("get_team", { query: targetId }));
      if (str(team.id) !== targetId) throw new ExternalServiceError(400, "Linear team not found");
      let label = str(team.name);
      if (projectId) {
        // Validate project membership using the provider's team filter, including pagination.
        let cursor: string | undefined;
        let found: RecordData | undefined;
        do {
          const result = await collection("list_projects", "projects", { team: targetId, limit: 50, ...(cursor ? { cursor } : {}) });
          found = result.list.find(p => p.id === projectId);
          if (result.cursor === cursor) break;
          cursor = result.cursor;
        } while (!found && cursor);
        if (!found) throw new ExternalServiceError(400, "Project does not belong to the selected team");
        label += ` / ${str(found.name)}`;
      }
      return { provider: "linear", targetId, ...(projectId ? { projectId } : {}), label };
    },
    async list(d, cursor) {
      const result = await collection("list_issues", "issues", { team: d.targetId, ...(d.projectId ? { project: d.projectId } : {}), limit: 50, ...(cursor ? { cursor } : {}) });
      return { issues: result.list.map(issue), cursor: result.cursor };
    },
    read,
    async write(d, input) {
      if (input.action !== "create") await read(d, input.issueId!);
      if (input.action === "comment") {
        const r = record(await call("create_comment", { issueId: input.issueId, body: input.body }));
        const original = await read(d, input.issueId!);
        if (!r.id) throw new ExternalServiceError(502, "Linear did not confirm the comment");
        return { ...original, id: str(r.id), title: `Comment on ${original.title}`, body: input.body!, url: str(r.url) || original.url };
      }
      return issue(await call("save_issue", {
        ...(input.action === "create" ? { team: d.targetId, ...(d.projectId ? { project: d.projectId } : {}) } : { id: input.issueId }),
        ...(input.title === undefined ? {} : { title: input.title }), ...(input.body === undefined ? {} : { description: input.body }),
      }));
    },
    close,
  };
}

export async function openLinearAdapter(token: string) {
  const client = await createMCPClient({ transport: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${token}` } } });
  return linearAdapter(async (name, args) => {
    const result = await client.callTool({ name, arguments: args, options: { timeout: 25000 } });
    if (result.isError) throw new ExternalServiceError(502, "Linear operation failed. Check access and inputs.");
    if (result.structuredContent) return result.structuredContent;
    for (const block of Array.isArray(result.content) ? result.content : []) {
      if (block.type === "text" && typeof block.text === "string") {
        try { return JSON.parse(block.text) as unknown; } catch { /* Require structured confirmation. */ }
      }
    }
    throw new ExternalServiceError(502, "Linear returned an unrecognized result; verify in Linear before retrying a write");
  }, () => client.close());
}

