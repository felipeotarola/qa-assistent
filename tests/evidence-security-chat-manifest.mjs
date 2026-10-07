// Offline compiler: existing source reports and six empty workspaces are
// provisioned by the runtime owner. No authentication, model or DB request.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { sha256 } from './helpers/evidence-acceptance.mjs';
import { SECURITY_CHAT_PROTOCOL, SECURITY_CHAT_CODE_FILES, validateSecurityChatManifest } from './helpers/evidence-security-chat.mjs';
import { SECURITY_CONTEXT_SCOPE, securityContextIntegrationFiles } from './helpers/security-context-runtime.mjs';
const root = resolve('.data/autonomy-isolation');
async function bytes(path) {
  const candidate = resolve(path), actual = await realpath(candidate), sub = relative(root, actual);
  assert.ok(candidate === actual && sub && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub));
  assert.ok((await stat(actual)).size <= 32 * 1024 * 1024); return readFile(actual);
}
assert.ok(process.argv.includes('--compile'), 'Use --compile --input=<private JSON>');
const input = JSON.parse(await bytes(process.argv.find(a => a.startsWith('--input='))?.slice(8)));
assert.ok(Object.keys(input).every(k => ['sourceManifest', 'model', 'reasoning', 'modelRequestIntervalMs', 'observationSeconds', 'trials', 'observeProviderContext'].includes(k)));
assert.ok(input.observeProviderContext === undefined || typeof input.observeProviderContext === 'boolean');
const sourceBytes = await bytes(input.sourceManifest), sources = JSON.parse(sourceBytes);
const code = {};
for (const [key, file] of Object.entries(SECURITY_CHAT_CODE_FILES)) code[key] = sha256(await readFile(file));
let contextObservation;
if (input.observeProviderContext === true) {
  const helperHashes = {};
  for (const file of securityContextIntegrationFiles) helperHashes[file] = sha256(await readFile(file));
  contextObservation = { version: 1, scope: SECURITY_CONTEXT_SCOPE, helperHashes };
}
const manifest = validateSecurityChatManifest({ protocol: SECURITY_CHAT_PROTOCOL, taskId: 'SEC-08', sourceHash: sources.sourceHash, runtime: sources.runtime,
  model: input.model, reasoning: input.reasoning, modelRequestIntervalMs: input.modelRequestIntervalMs,
  observationSeconds: input.observationSeconds ?? 600, sources: { path: input.sourceManifest, sha256: sha256(sourceBytes) }, code, trials: input.trials,
  ...(contextObservation ? { contextObservation } : {}) }, sources);
const path = resolve(root, `evidence-security-chat-manifest-${randomUUID()}.json`);
await writeFile(path, JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ result: 'compiled', manifest: path, networkRequests: 0, databaseWrites: 0, modelCalls: 0 }));
