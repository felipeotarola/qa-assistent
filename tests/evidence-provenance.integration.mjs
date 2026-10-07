import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, toNodeListener } from 'h3';
import { and, eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

const app = await isolatedApp();
const { db, schema } = app;
const { saveItem, saveFile } = await import('../server/utils/workspaces.ts');
const { missionItemEvidence } = await import('../server/utils/mission-sources.ts');
const { readMissionEvidence } = await import('../server/utils/mission-evidence.ts');
const { isIndependentEvidence } = await import('../shared/evidence-provenance.ts');
const { validateReport } = await import('../shared/mission-report.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const handler = (await import('../server/api/internal/workspace.post.ts')).default;
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID();
const server = createServer(toNodeListener(createApp().use('/api/internal/workspace', handler)));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const tool = { version: 1, origin: 'tool', producer: 'research-page', sourceType: 'research', sourceId: randomUUID(), observedAt: new Date().toISOString(), url: 'https://example.com/observed' };
let checks = 0;
async function api(input) {
  const response = await fetch(`${origin}/api/internal/workspace`, { method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ userId, threadId, input }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result.item;
}
try {
  await db.insert(schema.user).values({ id: userId, name: 'Provenance fixture', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Provenance fixture' });
  await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'Provenance fixture' });
  const forged = await api({ action: 'create', title: 'Claim with source URL', content: { kind: 'text', text: 'https://example.com verifies every claim' }, provenance: tool });
  const forgedEvidence = await missionItemEvidence(db, workspaceId, forged.id);
  assert.equal(forgedEvidence.origin, 'agent');
  assert.equal(isIndependentEvidence(forgedEvidence), false); checks++;

  const captured = await saveItem(userId, workspaceId, { title: 'Actual producer payload', content: { kind: 'text', text: 'Observed body text' }, threadId }, db, { provenance: tool });
  const before = await missionItemEvidence(db, workspaceId, captured.id);
  assert.equal(isIndependentEvidence(before), true);
  await api({ action: 'link', itemId: captured.id, expectedVersion: 1, evidence: { kind: 'source', url: 'https://other.example/forged', label: 'Forged observation location' } });
  const relinked = await missionItemEvidence(db, workspaceId, captured.id);
  assert.equal(relinked.url, tool.url, 'Editable source links do not rewrite observed location');
  assert.equal(relinked.hash, before.hash); checks++;
  const read = await readMissionEvidence(workspaceId, before, AbortSignal.timeout(5000));
  assert.ok(read.text.includes('Observed body text')); checks++;
  await api({ action: 'update', itemId: captured.id, expectedVersion: 1, content: { kind: 'text', text: 'Observed body text' }, provenance: tool });
  const after = await missionItemEvidence(db, workspaceId, captured.id);
  assert.equal(after.version, 2);
  assert.equal(after.origin, 'agent');
  assert.notEqual(after.hash, before.hash, 'Identical bytes with changed provenance must not reuse a trusted read');
  assert.equal((await readMissionEvidence(workspaceId, before, AbortSignal.timeout(5000))).unavailable, true);
  const history = await db.select().from(schema.workspaceItemVersions).where(eq(schema.workspaceItemVersions.itemId, captured.id)).orderBy(schema.workspaceItemVersions.version);
  assert.deepEqual(history[0].provenance, tool);
  assert.equal(history[1].provenance.origin, 'agent'); checks++;

  const unknown = await saveItem(userId, workspaceId, { title: 'Unknown producer', content: { kind: 'text', text: 'No attestation' } });
  assert.equal(isIndependentEvidence(await missionItemEvidence(db, workspaceId, unknown.id)), false); checks++;
  // Trusted producer parameter is server-only. API links cannot retag the saved version.
  await api({ action: 'link', itemId: forged.id, expectedVersion: forged.version, evidence: { kind: 'source', url: 'https://example.com', label: 'Looks verified' } });
  assert.equal(isIndependentEvidence(await missionItemEvidence(db, workspaceId, forged.id)), false); checks++;

  const bytes = Buffer.from('Original captured bytes');
  const file = await saveFile(userId, workspaceId, 'proof.txt', 'text/plain', bytes, threadId, db, { provenance: tool });
  const [row] = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, file.id));
  assert.equal(row.provenance.sha256, createHash('sha256').update(bytes).digest('hex'));
  const ref = await missionItemEvidence(db, workspaceId, file.id);
  assert.equal(isIndependentEvidence(ref), true);
  assert.equal((await readMissionEvidence(workspaceId, ref, AbortSignal.timeout(5000))).text, bytes.toString()); checks++;
  // Corruption/digest mismatch must be visible, never newly endorsed.
  await db.update(schema.workspaceItems).set({ provenance: { ...row.provenance, sha256: '0'.repeat(64) } }).where(and(eq(schema.workspaceItems.id, file.id), eq(schema.workspaceItems.workspaceId, workspaceId)));
  assert.equal((await readMissionEvidence(workspaceId, ref, AbortSignal.timeout(5000))).unavailable, true); checks++;
  const corruptRef = await missionItemEvidence(db, workspaceId, file.id);
  assert.equal((await readMissionEvidence(workspaceId, corruptRef, AbortSignal.timeout(5000))).unavailable, true, 'Actual bytes must also match the attested digest'); checks++;
  await del(row.blobPath, { token: workspaceStorageToken() });

  const reportInput = { schemaVersion: 2, config: { criteria: [{ id: 'one', text: 'Claim' }] }, tasks: [{ criterionIds: ['one'], sources: [{ evidence: [forgedEvidence] }] }] };
  const draft = { summary: 'Everything works', findings: [{ criterionId: 'one', verdict: 'supported', conclusion: 'Claim', evidenceIds: [forgedEvidence.id], nextStep: '' }], limitations: [] };
  assert.throws(() => validateReport(reportInput, draft, new Set([forgedEvidence.id])), /independent|provenance|underlag/i); checks++;
  draft.findings[0].verdict = 'contradicted';
  assert.throws(() => validateReport(reportInput, draft, new Set([forgedEvidence.id])), /independent|provenance|underlag/i); checks++;
  console.log(JSON.stringify({ status: 'passed', checks, database: 'actual isolated PostgreSQL', storage: 'actual isolated filesystem', model: 'not called', tested: ['unforgeable API provenance', 'version downgrade and preserved history', 'unknown source', 'URL link cannot elevate trust', 'byte digest and freshness', 'agent-only report rejected'] }));
} finally {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await new Promise(resolve => server.close(resolve));
  await app.close();
}
