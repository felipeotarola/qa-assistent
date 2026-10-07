import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedProcessEnvironment, readIsolationFixture } from './autonomy-isolation.mjs';
import { hash } from './browser-variants-protocol.mjs';

/** Import is inert. Only an explicit --execute installs this separate site in
 * the already-owned isolated network, while web/Eve are stopped. */
export function extraProvisioningScript(name, bytes, adminToken) {
  assert.match(name, /^SynaAutonomy-[a-f0-9]{12}$/);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length < 64 * 1024);
  assert.match(adminToken, /^[a-f0-9]{64}$/);
  const serverSha256 = hash(bytes), directory = `/opt/syna-autonomy/fixtures/browser-extra-${serverSha256.slice(0, 12)}`;
  const container = `qa-browser-extra-${serverSha256.slice(0, 12)}`;
  const configuration = JSON.stringify({ adminToken });
  const launcher = "import { readFileSync } from 'node:fs';\nimport { createExtraSite } from './server.mjs';\nconst server = createExtraSite(JSON.parse(readFileSync('/fixture/private.json','utf8')));\nserver.listen(80,'0.0.0.0');\nconst close=()=>{server.close();server.closeAllConnections();};\nprocess.once('SIGTERM',close);process.once('SIGINT',close);\n";
  const entries = [['server.mjs', bytes], ['launcher.mjs', Buffer.from(launcher)], ['private.json', Buffer.from(configuration)]];
  const files = entries.map(([file, content]) => `test ! -L ${directory}/${file}
if [ -f ${directory}/${file} ]; then
  test "$(sha256sum ${directory}/${file} | cut -d' ' -f1)" = '${hash(content)}'
else
  printf '%s' '${content.toString('base64')}' | base64 -d > ${directory}/${file}
fi
chmod 444 ${directory}/${file}
test "$(sha256sum ${directory}/${file} | cut -d' ' -f1)" = '${hash(content)}'`).join('\n');
  const script = `set -eu
test "$(docker network inspect -f '{{ index .Labels "syna.isolation" }}' qa-fixture-net)" = '${name}'
test "$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' qa-fixture-net)" = '192.0.2.0/24'
test "$(docker network inspect -f '{{.Internal}}' qa-fixture-net)" = 'true'
test "$(docker inspect -f '{{ index .Config.Labels "syna.isolation" }}' qa-browser)" = '${name}'
test "$(docker inspect -f '{{with index .NetworkSettings.Networks "qa-fixture-net"}}{{.IPAddress}}{{end}}' qa-browser)" = '192.0.2.20'
iptables -C DOCKER-USER -s 192.0.2.0/24 -j QA_FIXTURE_EGRESS
iptables -C QA_FIXTURE_EGRESS -j REJECT
test "$(readlink -m ${directory})" = '${directory}'
mkdir -p ${directory}
${files}
test "$(find ${directory} -mindepth 1 -maxdepth 1 -type f | wc -l)" = '3'
test "$(find ${directory} -mindepth 1 -maxdepth 1 | wc -l)" = '3'
if docker inspect ${container} >/dev/null 2>&1; then
  test "$(docker inspect -f '{{ index .Config.Labels "syna.isolation" }}' ${container})" = '${name}'
  test "$(docker inspect -f '{{ index .Config.Labels "syna.fixture.sha256" }}' ${container})" = '${serverSha256}'
  test "$(docker inspect -f '{{with index .NetworkSettings.Networks "qa-fixture-net"}}{{.IPAddress}}{{end}}' ${container})" = '192.0.2.12'
  docker start ${container} >/dev/null
else
  docker run -d --pull=never --name ${container} --label syna.isolation=${name} --label syna.fixture.sha256=${serverSha256} --runtime=runsc --init --network qa-fixture-net --ip 192.0.2.12 --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 64 --read-only --cap-drop ALL --security-opt no-new-privileges --mount type=bind,src=${directory},dst=/fixture,readonly qa-repo-runner:public node /fixture/launcher.mjs >/dev/null
fi
iptables -C QA_FIXTURE_EGRESS -s 192.0.2.20/32 -d 192.0.2.12/32 -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I QA_FIXTURE_EGRESS 2 -s 192.0.2.20/32 -d 192.0.2.12/32 -p tcp --dport 80 -j ACCEPT
docker exec -u root qa-browser sh -c 'grep -q "^192.0.2.12 qa-regression.test qa-auth.test$" /etc/hosts || { ! grep -E -q "qa-regression.test|qa-auth.test" /etc/hosts; printf "\\n192.0.2.12 qa-regression.test qa-auth.test\\n" >> /etc/hosts; }'
curl --silent --show-error --fail --head --retry 5 --retry-connrefused --retry-delay 1 --max-time 10 -H 'Host: qa-regression.test' http://192.0.2.12/regression/b | grep -i '^x-fixture-sha256: ${serverSha256}' >/dev/null
docker inspect -f '{{.Image}}' qa-browser
docker inspect -f '{{.Image}}' ${container}
docker inspect -f '{{.Id}}' ${container}
`;
  return { script, directory, container, serverSha256, launcherSha256: hash(launcher), privateConfigurationSha256: hash(configuration) };
}

async function main() {
  const args = process.argv.slice(2); assert.ok(args.length === 1 && ['--audit', '--execute'].includes(args[0]));
  const fixture = await readIsolationFixture(); isolatedProcessEnvironment(fixture);
  const linuxRoot = resolve('.data/autonomy-isolation/linux'), linux = JSON.parse(await readFile(resolve(linuxRoot, 'fixture.json'), 'utf8'));
  assert.equal(resolve(linux.path), resolve(linuxRoot, linux.name));
  const privatePath = resolve(linuxRoot, 'browser-variants-extra-auth.json');
  const existing = await readFile(privatePath, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const adminToken = existing?.adminToken ?? randomBytes(32).toString('hex');
  const prepared = extraProvisioningScript(linux.name, await readFile('tests/fixtures/browser-variants-extra-site.mjs'), adminToken);
  if (args[0] === '--audit') { console.log(JSON.stringify({ status: 'not_executed', container: prepared.container, serverSha256: prepared.serverSha256 })); return; }
  const appRoot = resolve('.data/autonomy-isolation', `application-${fixture.runtimeScope.split(':')[1]}`);
  assert.equal(resolve(fixture.app.root), appRoot);
  const runtime = JSON.parse(await readFile(resolve(appRoot, 'runtime.json'), 'utf8'));
  for (const service of ['web', 'eve']) {
    const pid = runtime[service]?.pid; if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    let exists = false;
    try { process.kill(pid, 0); exists = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    assert.equal(exists, false, 'Stop owned web/Eve and settle jobs before fixture provisioning');
  }
  if (!existing) await writeFile(privatePath, JSON.stringify({ adminToken, runtimeScope: fixture.runtimeScope }), { flag: 'wx', mode: 0o600 });
  else assert.equal(existing.runtimeScope, fixture.runtimeScope);
  const output = await new Promise((accept, reject) => {
    const child = spawn('wsl.exe', ['--distribution', linux.name, '--user', 'root', '--exec', 'sh', '-s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
    const out = []; child.stdout.on('data', bytes => out.push(bytes)); child.stderr.resume();
    child.on('error', reject); child.on('exit', code => code ? reject(new Error(`Owned extra fixture provisioning failed (${code}); no secret shell output emitted`)) : accept(Buffer.concat(out).toString().trim()));
    child.stdin.end(prepared.script); // Private configuration goes through stdin, never argv/logs.
  });
  const [browserImage, containerImage, containerId, extra] = output.split(/\r?\n/); assert.equal(extra, undefined);
  for (const image of [browserImage, containerImage]) assert.match(image, /^sha256:[a-f0-9]{64}$/); assert.match(containerId, /^[a-f0-9]{64}$/);
  const manifest = { schemaVersion: 1, kind: 'browser-variants-extra', origins: ['http://qa-regression.test', 'http://qa-auth.test'], address: '192.0.2.12', port: 80,
    runtimeScope: fixture.runtimeScope, transport: 'isolated-docker-public-origin', ...Object.fromEntries(Object.entries(prepared).filter(([key]) => key !== 'script')),
    oracleSha256: hash(await readFile('tests/fixtures/browser-variants-extra-oracle.json')), resolverSha256: hash(await readFile('tests/helpers/browser-variants-extra-resolver.mjs')),
    browserImage, containerImage, containerId, oracleNotServed: true, createdAt: new Date().toISOString() };
  const path = resolve(linuxRoot, 'browser-variants-extra-deployment.json'); await writeFile(path, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ status: 'provisioned', manifest: path, serverSha256: prepared.serverSha256 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
