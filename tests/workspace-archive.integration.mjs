import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isolatedApp } from './helpers/isolated-app.mjs';
const app = await isolatedApp();
const { sql, db, schema } = app;
const owner = randomUUID(), other = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID();
try {
  // Apply only this additive migration to the guarded, isolated database.
  const [column] = await sql`select 1 from information_schema.columns where table_name='pat_workspaces' and column_name='archived_at'`;
  if (!column) await sql.unsafe(await readFile(new URL('../server/db/migrations/postgresql/0030_workspace_archive.sql', import.meta.url), 'utf8'));
  const { setWorkspaceArchived } = await import('../server/utils/workspace-archive.ts');
  await db.insert(schema.user).values([{ id: owner, name: 'Archive test', email: `${owner}@example.test` }, { id: other, name: 'Other', email: `${other}@example.test` }]);
  await db.insert(schema.workspaces).values({ id: workspaceId, userId: owner, name: 'Retained workspace' });
  await db.insert(schema.threads).values({ id: threadId, userId: owner, workspaceId, title: 'Retained chat' });
  await assert.rejects(setWorkspaceArchived(other, workspaceId, true), e => e.statusCode === 404);
  const first = await setWorkspaceArchived(owner, workspaceId, true);
  assert.ok(first.workspace.archivedAt);
  assert.equal((await setWorkspaceArchived(owner, workspaceId, true)).workspace.archivedAt, first.workspace.archivedAt);
  assert.equal((await sql`select count(*)::int as n from pat_threads where id=${threadId}`)[0].n, 1);
  assert.equal((await setWorkspaceArchived(owner, workspaceId, false)).workspace.archivedAt, null);
  const missionId = randomUUID();
  await db.insert(schema.missions).values({ id: missionId, workspaceId, userId: owner, threadId, runtime: 'archive-test', requestId: randomUUID(), config: {}, lifecycle: 'active' });
  await assert.rejects(setWorkspaceArchived(owner, workspaceId, true), e => e.statusCode === 409);
  await sql`update pat_missions set lifecycle='closed', status='completed' where id=${missionId}`;
  const repoId = randomUUID(), runId = randomUUID();
  await db.insert(schema.repositories).values({ id: repoId, workspaceId, url: 'https://github.com/example/example' });
  await db.insert(schema.repositoryRuns).values({ id: runId, repositoryId: repoId, workspaceId, requestId: randomUUID(), config: {} });
  await assert.rejects(setWorkspaceArchived(owner, workspaceId, true), e => e.statusCode === 409);
  await sql`update pat_repository_runs set job='{"status":"passed"}'::jsonb where id=${runId}`;
  assert.ok((await setWorkspaceArchived(owner, workspaceId, true)).workspace.archivedAt);
  console.log('PASS: owner isolation, reversible/idempotent archive, retained chat, active mission and unconfirmed run guards, completed work archive');
} finally {
  await sql`delete from pat_threads where id=${threadId}`;
  await sql`delete from pat_workspaces where id=${workspaceId}`;
  await sql`delete from pat_user where id in (${owner}, ${other})`;
  await app.close();
}
