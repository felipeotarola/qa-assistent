/** Format legacy inline numbered steps without changing their factual content. */
export function runNarrative(text: string) {
  // Only add presentation boundaries; never infer or summarize results.
  return text
    .replace(/\s+\((\d{1,2})\)\s+/g, '\n\n$1. ')
    .replace(/([^\n])\s+(?=Steg\s+\d+(?:[–-]\d+)?\s*:)/g, '$1\n\n')
    .replace(/([^\n])\s+(?=Sammanfattning\s*:)/g, '$1\n\n');
}
