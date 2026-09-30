// Trusted supervisor inside the sandbox; project processes cannot reach the host.
const fs = require('node:fs'), { spawn } = require('node:child_process');
const [id, command, cwd, environment] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(id)) process.exit(2);
const directory = '/tmp/qa-processes'; fs.mkdirSync(directory, { recursive: true });
const file = `${directory}/${id}.json`;
const state = { id, pid: null, status: 'starting', stdout: '', stderr: '', exitCode: null, updatedAt: new Date().toISOString() };
function save() { state.updatedAt = new Date().toISOString(); fs.writeFileSync(file + '.tmp', JSON.stringify(state)); fs.renameSync(file + '.tmp', file); }
save();
const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, ...JSON.parse(environment) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
state.pid = child.pid; state.status = 'running'; save();
for (const key of ['stdout', 'stderr']) child[key].on('data', chunk => { state[key] = (state[key] + chunk.toString()).slice(-32000); });
const heartbeat = setInterval(save, 500);
child.on('error', error => { state.stderr = error.message; });
child.on('close', code => { clearInterval(heartbeat); state.status = 'completed'; state.exitCode = code ?? 137; save(); });
