// Older agent documents used pipe-separated rows without Markdown's separator.
// Repair only consistent multi-row groups for display; never rewrite saved data.
export function documentMarkdown(text: string) {
  const lines = text.split("\n");
  const output: string[] = [];
  let fence = "";
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]![0]!; else if (marker[1]![0] === fence) fence = ""; output.push(line); continue; }
    if (fence || /^ {4}|^\t/.test(line) || !line.includes("|")) { output.push(line); continue; }
    const group = [line];
    while (i + 1 < lines.length && lines[i + 1]!.trim() && lines[i + 1]!.includes("|")) group.push(lines[++i]!);
    const count = cells(line).length;
    const hasSeparator = group.length > 1 && cells(group[1]!).every(value => /^\s*:?-{3,}:?\s*$/.test(value));
    if (!hasSeparator && group.length >= 3 && count >= 2 && group.every(row => cells(row).length === count && !row.includes("`"))) {
      output.push(line, Array.from({ length: count }, () => "---").join(" | "), ...group.slice(1));
    } else output.push(...group);
  }
  return output.join("\n");
}
