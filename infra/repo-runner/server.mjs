import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Runner, terminal } from './runner.mjs';
const key = process.env.REPO_RUNNER_KEY;
if (!key || key.length < 32) throw new Error('REPO_RUNNER_KEY required');
const runner = new Runner({ directory: process.env.REPO_RUNNER_DATA || '/var/lib/qa-repo-runner' });
await runner.init();
const reply = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  const actual = req.headers.authorization || '', expected = `Bearer ${key}`;
  if (Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return reply(res, 401, { error: 'Unauthorized' });
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/health') return reply(res, 200, { ready: true, capacity: 1 });
    if (path === '/jobs' && req.method === 'POST') {
      let body = ''; for await (const part of req) { body += part; if (body.length > 4096) return reply(res, 413, { error: 'Request too large' }); }
      return reply(res, 200, await runner.submit(JSON.parse(body)));
    }
    const match = path.match(/^\/jobs\/([a-f0-9-]{36})(\/cancel)?$/);
    const job = match && runner.jobs.get(match[1]);
    if (!job) return reply(res, 404, { error: 'Run not found' });
    if (req.method === 'POST' && match[2]) await runner.cancel(job.id);
    else if (req.method !== 'GET' || match[2]) return reply(res, 405, { error: 'Method not allowed' });
    return reply(res, 200, job);
  } catch (error) { reply(res, 400, { error: error.message }); }
});
server.listen(8090, '100.122.229.15');
// Durable results remain on disk; retry delivery after outages or service restarts.
const delivered = new Set(); let delivering = false;
setInterval(async () => {
  if (delivering || !process.env.REPO_APP_URL || !process.env.INTERNAL_API_SECRET) return;
  delivering = true;
  try {
    for (const job of [...runner.jobs.values()].filter(j => terminal(j.status) && !delivered.has(j.id)).slice(-10)) {
      const response = await fetch(`${process.env.REPO_APP_URL}/api/internal/repository-result`, { method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(job), signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (response?.ok) delivered.add(job.id);
    }
  } finally { delivering = false; }
}, 5000).unref();
process.on('SIGTERM', async () => { server.close(); await Promise.all([...runner.controllers.keys()].map(id => runner.cancel(id))); });
