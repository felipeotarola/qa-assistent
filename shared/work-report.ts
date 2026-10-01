import type { RepoJob } from './repository';
import type { SandboxState } from './sandbox';

export interface WorkReport {
  id: string;
  at: string;
  actor: string;
  threadId?: string;
  title: string;
  result: string;
  next: string;
  prompt: string;
  category: 'result' | 'setup' | 'execution' | 'interrupted' | 'unknown';
}

// Classify structured worker facts only. Log text and model prose cannot prove a product defect.
export function repositoryReport(job: RepoJob): WorkReport | null {
  if (!['passed', 'failed', 'blocked', 'cancelled', 'review'].includes(job.status)) return null;
  const base = { id: `repository:${job.id}`, at: job.finishedAt || job.updatedAt, actor: 'Repository',
    prompt: `Läs det sparade resultatet och loggen för repositorykörning ${job.id}. Sammanfatta verifierat resultat, vad som inte testades och rekommendera ett nästa steg. Skilj produktfel från problem i körningen. Starta inte om och ändra ingen kod.` };
  if (job.status === 'cancelled') return { ...base, category: 'interrupted', title: 'Körningen avbröts', result: 'Avbrottet ger inget fullständigt testresultat.', next: 'Kontrollera sparade delresultat innan ett omtest.' };
  if (job.status === 'review') return { ...base, category: 'result', title: 'Projektet är undersökt', result: 'Körningsplanen finns. Inga tester har körts.', next: 'Granska planen och välj vad som ska verifieras.' };
  if (job.status === 'passed') return { ...base, category: 'result', title: 'Kommandot lyckades', result: job.telemetry?.operationKind === 'static-check' ? 'Statisk kontroll klar. Funktionella tester är inte verifierade.' : job.telemetry?.operationKind === 'build' ? 'Bygget lyckades. Appstart och funktioner är inte verifierade.' : 'Exitkod 0. Enskilda testfall behöver verifieras i resultatet.', next: 'Granska täckningen och välj nästa test.' };
  const kind = job.telemetry?.failureKind;
  if (kind === 'dependencies') return { ...base, category: 'setup', title: 'Installationen stoppade körningen', result: 'Beroenden kunde inte installeras. Testkommandot kördes inte.', next: 'Undersök installationsfelet innan du försöker igen.' };
  if (kind === 'checkout') return { ...base, category: 'setup', title: 'Repot kunde inte hämtas', result: 'Ingen testkörning startade.', next: 'Kontrollera repo-URL, branch och åtkomst.' };
  if (kind === 'configuration') return { ...base, category: 'setup', title: 'Körningsplanen behöver rättas', result: 'Projekt eller kommando kunde inte förberedas.', next: 'Kontrollera projektkatalog och tillgängliga kommandon.' };
  if (kind === 'timeout' || kind === 'interrupted') return { ...base, category: 'interrupted', title: kind === 'timeout' ? 'Tidsgränsen nåddes' : 'Körningen avbröts', result: 'Detta är inget verifierat produktfel.', next: 'Läs sista sparade steget och avgör vad som återstår.' };
  if (kind === 'runtime' || kind === 'cleanup') return { ...base, category: 'execution', title: 'Problem i körmiljön', result: 'Körningen kunde inte slutföras tillförlitligt.', next: 'Kontrollera VPS-miljön och eventuella sparade delresultat.' };
  return { ...base, category: 'unknown', title: job.status === 'failed' ? 'Kommandot misslyckades' : 'Körningen är blockerad', result: job.testExitCode != null ? `Exitkod ${job.testExitCode}. Orsaken är inte klassificerad som produktfel.` : 'Orsaken behöver undersökas. Inget produktfel är fastställt.', next: 'Läs felet och underlaget innan du väljer åtgärd.' };
}

export interface BrowserJobReportInput { id: string; status: string; updatedAt?: string; threadId?: string }
export function browserReport(job: BrowserJobReportInput): WorkReport | null {
  if (!['completed', 'failed', 'cancelled'].includes(job.status)) return null;
  return { id: `iris:${job.id}`, at: job.updatedAt || '', actor: 'Iris', threadId: job.threadId,
    category: job.status === 'completed' ? 'result' : job.status === 'cancelled' ? 'interrupted' : 'execution',
    title: job.status === 'completed' ? 'Iris har avslutat uppdraget' : job.status === 'cancelled' ? 'Webbtestningen stoppades' : 'Iris kunde inte slutföra uppdraget',
    result: 'Sparade testfall avgör vad som är godkänt. Avslutat uppdrag betyder inte att alla tester passerade.',
    next: 'Granska testresultaten och vad som återstår.',
    prompt: `Läs Iris sparade rapport för jobb ${job.id} och tillhörande testkörningar. Ge antal verifierat godkända, underkända, blockerade och otestade fall endast om underlaget räcker. Avsluta med ett rekommenderat nästa steg. Kör inga nya tester.` };
}

export function codexReport(job: NonNullable<SandboxState['codex']>, at: string): WorkReport | null {
  if (!['completed', 'failed', 'cancelled', 'timeout', 'interrupted','needs_configuration'].includes(job.status)) return null;
  if (job.status==='needs_configuration') return {id:`codex:${job.jobId}:configuration`,at:job.updatedAt||at,actor:'Codex',category:'setup',title:'Appen behöver konfiguration',result:`Saknade obligatoriska inställningar: ${job.environment?.variables.filter(v=>v.required).map(v=>v.name).join(', ')||'se rapporten'}. Tester har inte startat.`,next:'Öppna Pågående arbete och välj Konfigurera testmiljön.',prompt:''};
  const done = job.status === 'completed';
  return { id: `codex:${job.jobId}`, at: job.updatedAt || at, actor: 'Codex', category: done ? 'result' : job.status === 'failed' ? 'execution' : 'interrupted',
    title: done ? 'Codex har lämnat en rapport' : job.status === 'timeout' ? 'Codex nådde tidsgränsen' : 'Codex-uppdraget avbröts',
    result: done ? 'Rapporten finns i Pågående arbete. Jobbstatus bekräftar inte appstart eller godkända tester.' : 'Eventuella delresultat finns kvar. Uppdraget är inte verifierat klart.',
    next: 'Granska rapporten och kontrollera vad som faktiskt blev klart.',
    // Codex status is sandbox-scoped. Never send a different chat to create a
    // sandbox just to read this job; open its existing activity report instead.
    prompt: '' };
}

export function latestWorkReport(reports: WorkReport[], dismissed: string[]): WorkReport | null {
  return reports.filter(report => !dismissed.includes(report.id)).sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))[0] || null;
}
