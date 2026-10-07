import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedProcessEnvironment, readIsolationFixture } from './autonomy-isolation.mjs';
import { hash } from './browser-variants-protocol.mjs';

/** Generate a fixed, owner-fenced script; no caller-supplied shell fragments.
 * The private oracle and repository files other than the HTTP server are never
 * mounted into the container. Importing this module performs no operation. */
export function provisioningScript(name, bytes) {
  assert.match(name, /^SynaAutonomy-[a-f0-9]{12}$/);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length < 64 * 1024);
  const sha256 = hash(bytes), directory = `/opt/syna-autonomy/fixtures/browser-variants-${sha256.slice(0, 12)}`;
  const container = `qa-browser-variants-${sha256.slice(0, 12)}`;
  const launcher = "import { createBenchmarkSite } from './server.mjs';\nconst server = createBenchmarkSite();\nserver.listen(80, '0.0.0.0');\nconst close = () => { server.close(); server.closeAllConnections(); };\nprocess.once('SIGTERM', close); process.once('SIGINT', close);\n";
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
test ! -L ${directory}/server.mjs
test ! -L ${directory}/launcher.mjs
if [ -f ${directory}/server.mjs ]; then
  test "$(sha256sum ${directory}/server.mjs | cut -d' ' -f1)" = '${sha256}'
else
  printf '%s' '${bytes.toString('base64')}' | base64 -d > ${directory}/server.mjs
fi
if [ -f ${directory}/launcher.mjs ]; then
  test "$(sha256sum ${directory}/launcher.mjs | cut -d' ' -f1)" = '${hash(launcher)}'
else
  printf '%s' '${Buffer.from(launcher).toString('base64')}' | base64 -d > ${directory}/launcher.mjs
fi
chmod 444 ${directory}/server.mjs ${directory}/launcher.mjs
test "$(sha256sum ${directory}/server.mjs | cut -d' ' -f1)" = '${sha256}'
test "$(sha256sum ${directory}/launcher.mjs | cut -d' ' -f1)" = '${hash(launcher)}'
test "$(find ${directory} -mindepth 1 -maxdepth 1 -type f | wc -l)" = '2'
test "$(find ${directory} -mindepth 1 -maxdepth 1 | wc -l)" = '2'
if docker inspect ${container} >/dev/null 2>&1; then
  test "$(docker inspect -f '{{ index .Config.Labels "syna.isolation" }}' ${container})" = '${name}'
  test "$(docker inspect -f '{{ index .Config.Labels "syna.fixture.sha256" }}' ${container})" = '${sha256}'
  test "$(docker inspect -f '{{with index .NetworkSettings.Networks "qa-fixture-net"}}{{.IPAddress}}{{end}}' ${container})" = '192.0.2.11'
  docker start ${container} >/dev/null
else
  docker run -d --pull=never --name ${container} --label syna.isolation=${name} --label syna.fixture.sha256=${sha256} --runtime=runsc --init --network qa-fixture-net --ip 192.0.2.11 --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 64 --read-only --cap-drop ALL --security-opt no-new-privileges --mount type=bind,src=${directory},dst=/fixture,readonly qa-repo-runner:public node /fixture/launcher.mjs >/dev/null
fi
# Insert one exact allow rule; preserve all existing WEB-01 rules and final deny.
iptables -C QA_FIXTURE_EGRESS -s 192.0.2.20/32 -d 192.0.2.11/32 -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I QA_FIXTURE_EGRESS 2 -s 192.0.2.20/32 -d 192.0.2.11/32 -p tcp --dport 80 -j ACCEPT
docker exec -u root qa-browser sh -c 'grep -q "^192.0.2.11 qa-benchmark.test$" /etc/hosts || { ! grep -q "qa-benchmark.test" /etc/hosts; printf "\\n192.0.2.11 qa-benchmark.test\\n" >> /etc/hosts; }'
curl --silent --show-error --fail --head --retry 5 --retry-connrefused --retry-delay 1 --max-time 10 http://192.0.2.11/help | grep -i '^x-fixture-sha256: ${sha256}' >/dev/null
docker inspect -f '{{.Image}}' qa-browser
docker inspect -f '{{.Image}}' ${container}
docker inspect -f '{{.Id}}' ${container}
`;
  return { script, directory, container, serverSha256: sha256, launcherSha256: hash(launcher) };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 1 && ['--audit', '--execute'].includes(args[0]), 'Use --audit (files only) or explicit --execute');
  const fixture = await readIsolationFixture(); isolatedProcessEnvironment(fixture);
  const linuxRoot = resolve('.data/autonomy-isolation/linux'), linux = JSON.parse(await readFile(resolve(linuxRoot, 'fixture.json'), 'utf8'));
  assert.equal(resolve(linux.path), resolve(linuxRoot, linux.name));
  const prepared = provisioningScript(linux.name, await readFile('tests/fixtures/autonomy-benchmark-sites/server.mjs'));
  if (args[0] === '--audit') { console.log(JSON.stringify({ status: 'not_executed', container: prepared.container, serverSha256: prepared.serverSha256, launcherSha256: prepared.launcherSha256 })); return; }
  const appRoot = resolve('.data/autonomy-isolation', `application-${fixture.runtimeScope.split(':')[1]}`);
  assert.equal(resolve(fixture.app.root), appRoot);
  const runtime = JSON.parse(await readFile(resolve(appRoot, 'runtime.json'), 'utf8'));
  for (const service of ['web', 'eve']) {
    const pid = runtime[service]?.pid; if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    let exists = false;
    try { process.kill(pid, 0); exists = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    assert.equal(exists, false, 'Stop owned web/Eve and settle jobs before fixture provisioning');
  }
  const output = await new Promise((accept, reject) => {
    const child = spawn('wsl.exe', ['--distribution', linux.name, '--user', 'root', '--exec', 'sh', '-s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
    const out = [], err = []; child.stdout.on('data', bytes => out.push(bytes)); child.stderr.on('data', bytes => err.push(bytes));
    child.on('error', reject); child.on('exit', code => code ? reject(new Error(`Owned provisioning failed (${code}); ${Buffer.concat(err).toString().slice(0, 2000)}`)) : accept(Buffer.concat(out).toString().trim()));
    child.stdin.end(prepared.script);
  });
  const [image, containerImage, containerId, extra] = output.split(/\r?\n/);
  assert.equal(extra, undefined); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.match(containerImage, /^sha256:[a-f0-9]{64}$/); assert.match(containerId, /^[a-f0-9]{64}$/);
  const manifest = { schemaVersion: 1, origin: 'http://qa-benchmark.test', address: '192.0.2.11', port: 80, runtimeScope: fixture.runtimeScope,
    transport: 'isolated-docker-public-origin', directory: prepared.directory, container: prepared.container, serverSha256: prepared.serverSha256,
    launcherSha256: prepared.launcherSha256, oracleSha256: hash(await readFile('tests/fixtures/autonomy-benchmark-sites/oracle.json')),
    resolverSha256: hash(await readFile('tests/helpers/browser-variants-resolver.mjs')), browserImage: image, containerImage, containerId, oracleNotServed: true, createdAt: new Date().toISOString() };
  await writeFile(resolve(linuxRoot, 'browser-variants-deployment.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ status: 'provisioned', manifest: resolve(linuxRoot, 'browser-variants-deployment.json'), serverSha256: prepared.serverSha256 }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
