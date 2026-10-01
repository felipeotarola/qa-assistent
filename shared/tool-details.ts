export interface ToolDetail { label: string; text: string; code?: boolean }
const fields: Record<string, string> = { action: 'Åtgärd', command: 'Kommando', url: 'Adress', title: 'Rubrik', query: 'Sökning', question: 'Fråga', clarification: 'Förtydligande', expected: 'Förväntat resultat', message: 'Meddelande', summary: 'Sammanfattning', status: 'Status', exitCode: 'Exitkod', stdout: 'Utdata', stderr: 'Fellogg', error: 'Fel', errorText: 'Fel' };
function redact(text: string) {
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [dolt]').replace(/((?:password|token|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[dolt]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[dolt]@');
}
/** Project display fields, never credentials, metadata or raw reasoning. */
export function toolDetails(value: unknown): ToolDetail[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    if (!fields[key] || !['string', 'number', 'boolean'].includes(typeof entry) || entry === '') return [];
    const text = redact(String(entry));
    return [{ label: fields[key], text: text.length > 6000 ? `${text.slice(0, 6000)}\n… (förkortat)` : text, code: ['command', 'stdout', 'stderr'].includes(key) }];
  });
}
