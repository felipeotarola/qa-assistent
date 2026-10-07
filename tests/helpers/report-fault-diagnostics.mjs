import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';

const maximumBytes = 8 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Only the existing, fixed production diagnostic is recognized. Arbitrary
 * report failure, source prose, or provider output is never a freshness pass. */
export function reportFreshnessDiagnostics(text, reportId) {
  assert.match(reportId, /^[a-zA-Z0-9_-]{1,150}$/);
  const matches = [...text.matchAll(/^\[mission-report\] Attempt failed \{\r?\n((?:[ \t]+[^\r\n]*\r?\n){1,12})\}/gm)].filter(match => {
    const fields = match[1].split(/\r?\n/).map(line => line.trim());
    return fields.filter(line => line.startsWith('id:')).length === 1
      && fields.includes(`id: '${reportId}',`)
      && fields.includes("type: 'Error',")
      && fields.includes("reason: 'Evidence changed during review',");
  });
  return { reportId, reason: 'Evidence changed during review', occurrences: matches.length,
    matchedDiagnosticSha256: matches.map(match => digest(match[0])) };
}

export async function reportLogBoundary(appRoot) {
  const root = await realpath(resolve('.data/autonomy-isolation')), actual = await realpath(appRoot), sub = relative(root, actual);
  assert.ok(sub && !isAbsolute(sub) && sub !== '..' && !sub.startsWith(`..${sep}`), 'Expected owned isolated application logs');
  const files = [];
  for (const name of ['web-stdout.log', 'web-stderr.log']) {
    const path = resolve(actual, name); assert.equal(await realpath(path), path);
    const info = await stat(path); assert.ok(info.isFile());
    files.push({ path, name, offset: info.size, ino: info.ino, dev: info.dev });
  }
  return files;
}

/** Never export raw log text. Read only append bytes from the pre-submit
 * boundary; rotations, truncation, or an over-budget log invalidate proof. */
export async function readReportFreshnessDiagnostics(boundary, reportId) {
  const files = [];
  for (const entry of boundary) {
    assert.equal(await realpath(entry.path), entry.path);
    const file = await open(entry.path, 'r');
    try {
      const info = await file.stat(); assert.ok(info.isFile() && info.ino === entry.ino && info.dev === entry.dev && info.size >= entry.offset);
      const length = info.size - entry.offset; assert.ok(length <= maximumBytes, 'Freshness diagnostic log budget exceeded');
      const bytes = Buffer.alloc(length); let position = 0;
      while (position < length) {
        const { bytesRead } = await file.read(bytes, position, length - position, entry.offset + position);
        assert.ok(bytesRead > 0, 'Log changed during freshness observation'); position += bytesRead;
      }
      const proof = reportFreshnessDiagnostics(bytes.toString('utf8'), reportId);
      if (proof.occurrences) files.push({ name: entry.name, startOffset: entry.offset, endOffset: info.size, appendedSha256: digest(bytes), ...proof });
    } finally { await file.close(); }
  }
  assert.ok(files.length, 'No exact final freshness rejection was observed; an arbitrary failed report is not this fault');
  return { reportId, reason: 'Evidence changed during review', files };
}
