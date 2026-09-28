/** Format legacy inline numbered steps without changing their factual content. */
export function runNarrative(text: string) {
  return text.replace(/\s+\((\d{1,2})\)\s+/g, '\n\n$1. ');
}
