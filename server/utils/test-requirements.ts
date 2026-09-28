import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, desc, sql, isNotNull, isNull } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { testRequirements } from '../db/schema/test-requirements';
import { ownedItem } from './workspaces';
import { destinations, externalOperation } from './external';
import { requirementToolSchema, requirementSection } from '../../shared/test-requirement';
import type { ExternalIssue } from '../../shared/external';
import { contentSchema, documentText } from '../../shared/workspace';

function publicRequirement(row: typeof testRequirements.$inferSelect) {
  // Provider body snapshots and prepared writes stay server-side.
  const { preparedBody: _body, destination: _destination, requestId: _requestId, workspaceId: _workspaceId, userId: _userId, ...value } = row;
  return { ...value, issue: value.issue ? { ...value.issue, body: '' } : null };
}
async function requireCase(userId: string, workspaceId: string, itemId: string, caseId: string) {
  const item = await ownedItem(userId, workspaceId, itemId);
  if (item.content.kind !== 'test_plan' || !item.content.cases.some(c => c.id === caseId)) throw createError({ statusCode: 404, statusMessage: 'Test case not found' });
  return item;
}
export async function requirementAction(userId: string, workspaceId: string, input: unknown) {
  const parsed = requirementToolSchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Kontrollera fråga, krav och testfall.' });
  const action = parsed.data;
  const item = await requireCase(userId, workspaceId, action.itemId, action.caseId);
  if (action.action === 'list') return (await db.select().from(testRequirements).where(and(eq(testRequirements.itemId, item.id), eq(testRequirements.caseId, action.caseId))).orderBy(desc(testRequirements.createdAt))).map(publicRequirement);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`requirement-proposal:${workspaceId}:${action.requestId}`}, 0))`);
    const [existing] = await tx.select().from(testRequirements).where(and(eq(testRequirements.workspaceId, workspaceId), eq(testRequirements.requestId, action.requestId)));
    if (existing) {
      if (existing.itemId !== item.id || existing.caseId !== action.caseId || existing.question !== action.question || existing.clarification !== action.clarification || existing.expected !== action.expected || existing.planVersion !== action.expectedVersion || existing.sourceItemId !== (action.sourceItemId ?? null) || existing.requestedIssueId !== (action.issueId?.trim() || null)) throw createError({ statusCode: 409, statusMessage: 'Förslaget har redan sparats med annat innehåll.' });
      return publicRequirement(existing);
    }
    if (item.version !== action.expectedVersion) throw createError({ statusCode: 409, statusMessage: 'Testplanen har ändrats. Läs den igen innan du sparar förslaget.' });
    const source = action.sourceItemId ? await ownedItem(userId, workspaceId, action.sourceItemId) : null;
    if (source && source.content.kind !== 'text') throw createError({ statusCode: 400, statusMessage: 'Välj ett kravdokument i Material.' });
    const issueId = action.issueId?.trim();
    const destination = issueId ? (await destinations(userId, workspaceId)).find(d => d.provider === 'linear') : null;
    const issue = issueId ? (await externalOperation(userId, workspaceId, 'read', { action: 'read', provider: 'linear', issueId }) as { issue: ExternalIssue }).issue : null;
    const id = randomUUID();
    const preparedBody = issue ? `${issue.body}\n\n${requirementSection(id, action.caseId, action.question, action.clarification, action.expected)}` : null;
    if (preparedBody && preparedBody.length > 50000) throw createError({ statusCode: 400, statusMessage: 'Linear-ärendet är för stort för detta tillägg.' });
    const [saved] = await tx.insert(testRequirements).values({ id, workspaceId, itemId: item.id, caseId: action.caseId, userId, requestId: action.requestId, question: action.question, clarification: action.clarification, expected: action.expected, requestedIssueId: issueId || null, planVersion: item.version, sourceItemId: source?.id, sourceVersion: source?.version, issue, destination, preparedBody }).returning();
    return publicRequirement(saved!);
  });
}

export async function publishRequirement(userId: string, workspaceId: string, id: string, expectedVersion: number) {
  // Publication and application are separate durable stages. A provider success
  // survives a local conflict; retries use the exact same external receipt key.
  return db.transaction(async lock => {
    await lock.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`requirement-publish:${workspaceId}`}, 0))`);
    const [record] = await db.select().from(testRequirements).where(and(eq(testRequirements.id, id), eq(testRequirements.workspaceId, workspaceId)));
    if (!record) throw createError({ statusCode: 404, statusMessage: 'Förslaget hittades inte.' });
    const item = await requireCase(userId, workspaceId, record.itemId, record.caseId);
    if (record.appliedVersion) return publicRequirement(record);
    const [newer] = await db.select().from(testRequirements).where(and(eq(testRequirements.itemId, record.itemId), eq(testRequirements.caseId, record.caseId), isNotNull(testRequirements.appliedVersion))).orderBy(desc(testRequirements.createdAt)).limit(1);
    if (newer && newer.createdAt > record.createdAt) throw createError({ statusCode: 409, statusMessage: 'Ett senare krav har redan tillämpats. Granska det och skapa ett nytt förslag.' });
    if (!record.issue || !record.preparedBody || !record.clarification || !record.expected) throw createError({ statusCode: 400, statusMessage: 'Komplettera förslaget med Linear-ärende, beslutat krav och förväntat resultat.' });
    if (item.version !== expectedVersion) throw createError({ statusCode: 409, statusMessage: 'Testplanen har ändrats. Läs den senaste versionen innan du fortsätter.' });
    const target = (await destinations(userId, workspaceId)).find(d => d.provider === 'linear');
    if (!isDeepStrictEqual(target, record.destination)) throw createError({ statusCode: 409, statusMessage: 'Linear-destinationen har ändrats. Återställ kopplingen eller skapa ett nytt förslag.' });
    if (!record.publishedAt) {
      if (record.planVersion !== item.version) throw createError({ statusCode: 409, statusMessage: 'Förslaget gäller en äldre planversion. Granska och spara ett nytt förslag.' });
      const key = `test-requirement:${record.id}`;
      const pending = await db.select().from(testRequirements).where(and(eq(testRequirements.workspaceId, workspaceId), isNull(testRequirements.publishedAt)));
      for (const prior of pending) {
        if (prior.id === id || prior.issue?.id !== record.issue.id) continue;
        const priorId = createHash('sha256').update(`${prior.userId}:${workspaceId}:test-requirement:${prior.id}`).digest('hex');
        const [uncertain] = await db.select().from(schema.externalOperations).where(eq(schema.externalOperations.id, priorId));
        if (uncertain && ['pending', 'unknown'].includes(uncertain.state)) throw createError({ statusCode: 409, statusMessage: 'En tidigare uppdatering av detta Linear-ärende har okänt utfall. Kontrollera den innan ett nytt förslag publiceras.' });
      }
      const receiptId = createHash('sha256').update(`${userId}:${workspaceId}:${key}`).digest('hex');
      const [receipt] = await db.select().from(schema.externalOperations).where(eq(schema.externalOperations.id, receiptId));
      if (!receipt) {
        const current = (await externalOperation(userId, workspaceId, 'read', { action: 'read', provider: 'linear', issueId: record.issue.id }) as { issue: ExternalIssue }).issue;
        if (current.body !== record.issue.body) throw createError({ statusCode: 409, statusMessage: 'Kravet har ändrats i Linear. Läs och spara ett nytt förslag innan du publicerar.' });
      }
      await externalOperation(userId, workspaceId, key, { action: 'update', provider: 'linear', issueId: record.issue.id, body: record.preparedBody });
      // Deliberately outside the local apply transaction: never undo knowledge
      // of a confirmed external write when applying the local plan fails.
      await db.update(testRequirements).set({ publishedAt: new Date() }).where(eq(testRequirements.id, id));
    }
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
      const current = await ownedItem(userId, workspaceId, record.itemId);
      if (current.version !== expectedVersion || current.content.kind !== 'test_plan' || !current.content.cases.some(c => c.id === record.caseId)) throw createError({ statusCode: 409, statusMessage: 'Sparat i Linear. Testplanen ändrades under tiden; lokal uppdatering återstår. Läs planen och slutför sedan.' });
      const [previous] = await tx.select().from(testRequirements).where(and(eq(testRequirements.itemId, record.itemId), eq(testRequirements.caseId, record.caseId), isNotNull(testRequirements.appliedVersion))).orderBy(desc(testRequirements.createdAt)).limit(1);
      const materialId = previous?.materialId ?? randomUUID();
      const [document] = await tx.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, materialId));
      // This document is an explicit local snapshot of Linear, not a competing
      // editable authority. Preserve any user additions by appending decisions.
      if (document && (document.deletedAt || document.content.kind !== 'text')) throw createError({ statusCode: 409, statusMessage: 'Sparat i Linear. Återställ kravdokumentet i Material innan du slutför.' });
      const materialVersion = (document?.version ?? 0) + 1;
      const section = requirementSection(record.id, record.caseId, record.question, record.clarification, record.expected);
      const text = `${document?.content.kind === 'text' ? document.content.text + '\n\n' : '# Krav & beslut\n\nLinear är huvudkälla. Detta dokument innehåller beslut sparade genom appen; externa ändringar hämtas inte automatiskt.\n\n'}${section}\n\nKälla: [${record.issue!.title}](${record.issue!.url})\nBekräftat ${new Date().toISOString()}${record.sourceItemId ? `\nUnderlag: ${record.sourceItemId} · v${record.sourceVersion}` : ''}`;
      if (text.length > 200000) throw createError({ statusCode: 409, statusMessage: 'Sparat i Linear. Kravdokumentet är fullt och behöver arkiveras innan lokal uppdatering.' });
      const content = { kind: 'text' as const, text, ...(document?.content.kind === 'text' && document.content.blocks ? { blocks: [...document.content.blocks, { kind: 'text' as const, text: section + `\n\nKälla: ${record.issue!.url}` }] } : {}) };
      if (content.blocks) content.text = documentText(content.blocks);
      if (!contentSchema.safeParse(content).success) throw createError({ statusCode: 409, statusMessage: 'Sparat i Linear. Kravdokumentet behöver kortas innan lokal uppdatering kan slutföras.' });
      const title = document?.title ?? `Krav – ${current.content.cases.find(c => c.id === record.caseId)!.title}`.slice(0, 200);
      const values = { title, content, version: materialVersion, updatedAt: new Date() };
      if (document) await tx.update(schema.workspaceItems).set(values).where(eq(schema.workspaceItems.id, materialId));
      else await tx.insert(schema.workspaceItems).values({ id: materialId, workspaceId, ...values });
      await tx.insert(schema.workspaceItemVersions).values({ id: randomUUID(), itemId: materialId, version: materialVersion, title, content });
      const sources = current.content.sources.filter(s => s.itemId !== materialId);
      if (sources.length >= 20) throw createError({ statusCode: 409, statusMessage: 'Sparat i Linear. Planen har redan 20 underlag. Frigör en plats och slutför igen.' });
      const plan = { ...current.content, sources: [...sources, { itemId: materialId, version: materialVersion }], cases: current.content.cases.map(c => c.id === record.caseId ? { ...c, expected: record.expected } : c) };
      const version = current.version + 1;
      await tx.update(schema.workspaceItems).set({ content: plan, version, updatedAt: new Date() }).where(eq(schema.workspaceItems.id, current.id));
      await tx.insert(schema.workspaceItemVersions).values({ id: randomUUID(), itemId: current.id, version, title: current.title, content: plan });
      const [saved] = await tx.update(testRequirements).set({ appliedVersion: version, materialId }).where(eq(testRequirements.id, id)).returning();
      return publicRequirement(saved!);
    });
  });
}
