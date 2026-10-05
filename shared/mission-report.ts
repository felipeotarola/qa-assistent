import { z } from 'zod';
import type { MissionSnapshot } from './mission.ts';

export const reportDraftSchema = z.object({
  summary: z.string().min(1).max(3000),
  findings: z.array(z.object({ criterionId: z.string().max(80), verdict: z.enum(['supported', 'needs_evidence', 'contradicted']), conclusion: z.string().min(1).max(3000), evidenceIds: z.array(z.string().max(120)).max(30), nextStep: z.string().max(2000) })).min(1).max(50),
  limitations: z.array(z.string().max(2000)).max(50),
});
export type ReportDraft = z.infer<typeof reportDraftSchema>;
export type ReportDocument = { schemaVersion: 1; title: string; capturedAt: string; revision: number; goal: string; scope: string; criteria: MissionSnapshot['config']['criteria']; target: string; partial: boolean; summary: string; findings: ReportDraft['findings']; limitations: string[]; tests: MissionSnapshot['tests']; metrics: MissionSnapshot['metrics']; tasks: { id: string; title: string; actor: string; parentId: string | null; dependsOn: string[]; status: string; reportedOutcome: string; startedAt: string | null; finishedAt: string | null }[]; evidence: { id: string; title: string; itemId: string | null; version: number | null; kind: string; url: string | null; observedAt: string | null; read: boolean }[] };

export function validateReport(snapshot: MissionSnapshot, value: unknown, readIds: Set<string>) {
  const draft = reportDraftSchema.parse(value);
  const expected = snapshot.config.criteria.map(c => c.id);
  if (draft.findings.length !== expected.length || new Set(draft.findings.map(f => f.criterionId)).size !== expected.length || draft.findings.some(f => !expected.includes(f.criterionId))) throw new Error('Report must cover every original criterion');
  for (const finding of draft.findings) {
    if (finding.evidenceIds.some(id => !readIds.has(id))) throw new Error('Unread report citation');
    const applicable = new Set(snapshot.tasks.filter(t => t.criterionIds.includes(finding.criterionId)).flatMap(t => t.sources.flatMap(s => s.evidence.map(e => e.id))));
    if (finding.evidenceIds.some(id => !applicable.has(id))) throw new Error('Evidence belongs to another criterion');
    if (finding.verdict === 'supported' && !finding.evidenceIds.length) throw new Error('Supported conclusion requires read evidence');
    const independent = snapshot.tasks.flatMap(t => t.sources.flatMap(s => s.evidence)).filter(e => !e.unavailable && e.origin !== 'agent');
    if (finding.verdict === 'supported' && !finding.evidenceIds.some(id => independent.some(e => e.id === id))) throw new Error('Supported conclusion requires independent evidence');
  }
  return draft;
}
export function assembleReport(snapshot: MissionSnapshot, draft: ReportDraft, readIds: Set<string>): ReportDocument {
  const evidence = [...new Map(snapshot.tasks.flatMap(t => t.sources.flatMap(s => s.evidence)).map(e => [e.id, e])).values()];
  return { schemaVersion: 1, title: snapshot.config.title, capturedAt: snapshot.capturedAt, revision: snapshot.revision, goal: snapshot.config.goal, scope: snapshot.config.scope, criteria: snapshot.config.criteria,
    target: snapshot.config.target ? [snapshot.config.target.environment, snapshot.config.target.url, snapshot.config.target.revision].filter(Boolean).join(' · ') : 'Testobjekt ej angivet',
    partial: snapshot.status !== 'closed' || snapshot.tasks.some(t => !t.sources.length || t.sources.some(s => ['running', 'planned', 'unknown'].includes(s.status))),
    ...draft, limitations: [...new Set([...snapshot.gaps, ...draft.limitations])], tests: snapshot.tests, metrics: snapshot.metrics,
    tasks: snapshot.tasks.map(t => ({ id: t.id, title: t.title, actor: t.actor, parentId: t.parentId, dependsOn: t.dependsOn, status: !t.sources.length ? 'planned' : t.sources.some(s => s.status === 'running') ? 'running' : t.sources.some(s => s.status === 'failed') ? 'failed' : t.sources.every(s => s.status === 'completed') ? 'completed' : t.sources.every(s => ['completed', 'cancelled'].includes(s.status)) ? 'cancelled' : 'unknown', reportedOutcome: t.sources.some(s => s.reportedOutcome === 'blocked') ? 'blocked' : t.sources.length && t.sources.every(s => s.reportedOutcome === 'achieved') ? 'achieved' : t.sources.some(s => ['partial', 'achieved'].includes(s.reportedOutcome)) ? 'partial' : 'unknown', startedAt: t.sources.map(s => s.startedAt).filter((v): v is string => !!v).sort()[0] ?? null, finishedAt: t.sources.some(s => !s.finishedAt) ? null : t.sources.map(s => s.finishedAt).filter((v): v is string => !!v).sort().at(-1) ?? null })),
    evidence: evidence.map(e => ({ id: e.id, title: e.title, itemId: e.itemId, version: e.version, kind: e.kind, url: e.url, observedAt: e.observedAt, read: readIds.has(e.id) })) };
}

export function reportText(document: ReportDocument) {
  return [`${document.title}\nKlara · revision ${document.revision} · ${document.capturedAt}\n${document.partial ? 'Delrapport' : 'Slutrapport'}`, document.target, `Mål\n${document.goal}\n${document.scope}`, document.summary,
    ...document.metrics.map(m => `${m.label}\n${m.data.map(p => `${p.label}: ${p.value}`).join('\n')}`),
    ...document.findings.map(f => `${document.criteria?.find(c => c.id === f.criterionId)?.text ?? f.criterionId}\n${f.verdict}: ${f.conclusion}\nNästa steg: ${f.nextStep}\nUnderlag: ${f.evidenceIds.join(', ')}`),
    ...document.tests.map(t => `${t.title} · ${t.target}: ${t.status} · granskning ${t.review}${t.manualReview ? `\nManuell bedömning: ${t.manualReview}` : ''}`),
    ...document.tasks.map(t => `${t.title}: ${t.status} · ${t.startedAt ?? 'Okänd start'} → ${t.finishedAt ?? 'Saknar sluttid'}`),
    `Begränsningar\n${document.limitations.join('\n')}`, `Underlag\n${document.evidence.map(e => `${e.title} · ${e.observedAt ?? 'Okänd tid'} · ${e.read ? 'Läst' : 'Inte läst'}${e.url ? `\n${e.url}` : ''}`).join('\n')}`].join('\n\n');
}
