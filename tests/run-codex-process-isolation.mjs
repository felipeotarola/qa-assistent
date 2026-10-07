import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Transfer only these two source files into an owned ephemeral WSL directory.
// The distro deliberately has no Windows drive mount or interop enabled.
const paths = ['tests/codex-process-isolation.linux.mjs', 'infra/codex-worker/client.mjs'];
const files = await Promise.all(paths.map(async path => ({ path, data: (await readFile(path)).toString('base64') })));
const bootstrap = String.raw`
import {mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks).toString());
if (!/^\/tmp\/syna-codex-group-suite-[a-f0-9-]{36}$/.test(input.root)) throw Error('Invalid owned suite root');
await mkdir(input.root); if(await realpath(input.root)!==input.root) throw Error('Suite root is not physical');
try {
 for(const file of input.files) {
  if(!['tests/codex-process-isolation.linux.mjs','infra/codex-worker/client.mjs'].includes(file.path)) throw Error('Unknown source');
  const path=resolve(input.root,file.path); await mkdir(dirname(path),{recursive:true}); await writeFile(path,Buffer.from(file.data,'base64'));
 }
 const output=execFileSync(process.execPath,[resolve(input.root,'tests/codex-process-isolation.linux.mjs')],{encoding:'utf8',timeout:25000,env:{PATH:'/usr/bin:/bin',WSL_DISTRO_NAME:process.env.WSL_DISTRO_NAME,SYNA_CODEX_GROUP_TEST:'isolated'}});
 const summary=JSON.parse(output.trim().split('\n').at(-1));
 if(!summary.artifact.startsWith(input.root+'/.data/autonomy-isolation/')) throw Error('Artifact escaped owned suite');
 console.log(JSON.stringify({summary,artifact:JSON.parse(await readFile(summary.artifact,'utf8'))}));
} finally { if(await realpath(input.root)!==input.root) throw Error('Suite root changed'); await rm(input.root,{recursive:true,force:true}); }
`;
const result = JSON.parse(execFileSync('wsl.exe', ['-d', 'SynaAutonomy-ff9dd82d1748', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', bootstrap], {
  input: JSON.stringify({ root: `/tmp/syna-codex-group-suite-${randomUUID()}`, files }), encoding: 'utf8', timeout: 30000, windowsHide: true,
}));
const artifact = resolve(`.data/autonomy-isolation/codex-process-isolation-${randomUUID()}.json`);
await writeFile(artifact, JSON.stringify({ ...result.artifact, sourceHashes: Object.fromEntries(files.map(file => [file.path, createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex')])) }, null, 2));
console.log(JSON.stringify({ passed: result.summary.passed, scenarios: result.summary.scenarios, artifact, models: 'none' }));
