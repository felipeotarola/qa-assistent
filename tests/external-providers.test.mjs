import { test } from "node:test";
import assert from "node:assert/strict";
import { githubAdapter, linearAdapter } from "../server/utils/external-providers.ts";

const githubTarget = { provider: "github", targetId: "example/qa", label: "example/qa" };
const issue = { number: 12, title: "Login broken", body: "Steps", html_url: "https://github.com/example/qa/issues/12", state: "open" };
test("GitHub operations use only the chosen repository and personal bearer", async () => {
  const calls = [];
  const adapter = githubAdapter("user-token", async (url, options) => {
    calls.push({ url, ...options });
    return Response.json(issue);
  });
  const result = await adapter.write(githubTarget, { action: "create", title: "Login broken", body: "Steps" });
  assert.equal(result.url, issue.html_url);
  assert.equal(calls[0].url, "https://api.github.com/repos/example/qa/issues");
  assert.equal(calls[0].headers.Authorization, "Bearer user-token");
  assert.equal(calls[0].redirect, "error");
  await assert.rejects(adapter.read(githubTarget, "../../other"));
  await assert.rejects(adapter.validate("example/qa/../../other"));
  assert.equal(calls.length, 1);
});
test("GitHub update preserves omitted fields; comments use issue endpoint", async () => {
  const calls = [];
  const adapter = githubAdapter("token", async (url, options) => { calls.push({ url, ...options }); return Response.json(issue); });
  await adapter.write(githubTarget, { action: "update", issueId: "12", title: "Revised" });
  assert.equal(calls[0].method, "GET");
  assert.deepEqual(JSON.parse(calls[1].body), { title: "Revised" });
  await adapter.write(githubTarget, { action: "comment", issueId: "12", body: "Reproduced" });
  assert.equal(calls.at(-1).url, "https://api.github.com/repos/example/qa/issues/12/comments");
  assert.deepEqual(JSON.parse(calls.at(-1).body), { body: "Reproduced" });
});
test("GitHub rejects PR mutation and revoked access without writing", async () => {
  const methods = [];
  const adapter = githubAdapter("token", async (_, options) => { methods.push(options.method); return Response.json({ ...issue, pull_request: {} }); });
  await assert.rejects(adapter.write(githubTarget, { action: "update", issueId: "12", title: "No" }), /pull requests/);
  assert.deepEqual(methods, ["GET"]);
  await assert.rejects(githubAdapter("token", async () => new Response("private response", { status: 403 })).destinations(), /GitHub returned 403/);
});
test("GitHub paginates repositories and validates cursor", async () => {
  const urls = [];
  const adapter = githubAdapter("token", async url => { urls.push(url); return Response.json(Array.from({ length: 100 }, (_, i) => ({ full_name: `example/r${i}` }))); });
  assert.equal((await adapter.destinations()).cursor, "2");
  await adapter.destinations("2");
  assert.match(urls[1], /page=2$/);
  await assert.rejects(adapter.destinations("1&evil=true"));
});
const linearTarget = { provider: "linear", targetId: "team-a", projectId: "project-a", label: "QA / App" };
const linearIssue = { id: "issue-a", title: "Login", description: "Steps", url: "https://linear.app/example/issue/QA-1", teamId: "team-a", projectId: "project-a" };
test("Linear scopes lists and writes to selected team/project", async () => {
  const calls = [];
  const adapter = linearAdapter(async (name, args) => {
    calls.push({ name, args });
    return name === "list_issues" ? { issues: [linearIssue] } : linearIssue;
  });
  await adapter.list(linearTarget);
  assert.deepEqual(calls[0].args, { team: "team-a", project: "project-a", limit: 50 });
  await adapter.write(linearTarget, { action: "create", title: "Login", body: "Steps" });
  assert.deepEqual(calls[1], { name: "save_issue", args: { team: "team-a", project: "project-a", title: "Login", description: "Steps" } });
});
test("Linear forbids cross-team/project writes and missing scope metadata", async () => {
  for (const bad of [{ teamId: "other" }, { projectId: "other" }, { teamId: undefined }]) {
    const calls = [];
    const adapter = linearAdapter(async name => { calls.push(name); return { ...linearIssue, ...bad }; });
    await assert.rejects(adapter.write(linearTarget, { action: "update", issueId: "issue-a", title: "No" }), /scope/);
    assert.deepEqual(calls, ["get_issue"]);
  }
});
test("Linear verifies project membership across pages", async () => {
  const adapter = linearAdapter(async (name, args) => {
    if (name === "get_team") return { id: "team-a", name: "QA" };
    assert.equal(args.limit, 50, "Linear projects API permits at most 50 results per page");
    return args.cursor ? { projects: [{ id: "project-a", name: "App" }], hasNextPage: false } : { projects: [], hasNextPage: true, cursor: "next" };
  });
  assert.equal((await adapter.validate("team-a", "project-a")).label, "QA / App");
  await assert.rejects(adapter.validate("team-a", "unrelated"), /does not belong/);
});
test("Linear fails explicitly on response shape drift", async () => {
  const adapter = linearAdapter(async () => ({ ok: true }));
  await assert.rejects(adapter.destinations(), /Unexpected Linear response/);
  await assert.rejects(adapter.write(linearTarget, { action: "create", title: "No" }), /no issue ID/);
});
