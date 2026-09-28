import { createConnection } from 'node:net';

// Internal agent calls use localhost:3000. Nuxt must not silently fall back to
// 3001 and attach a second frontend to the first frontend's Eve child process.
const occupied = await Promise.all(['127.0.0.1', '::1'].map(host => new Promise((resolve, reject) => {
  const socket = createConnection({ host, port: 3000 });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', error => {
    socket.destroy();
    if (['ECONNREFUSED', 'EAFNOSUPPORT', 'ENETUNREACH'].includes(error.code)) resolve(false);
    else reject(error);
  });
  socket.once('timeout', () => { socket.destroy(); reject(new Error(`Timed out checking ${host}:3000`)); });
})));
if (occupied.some(Boolean)) {
  console.error('Port 3000 is already in use. Reuse http://localhost:3000 or stop the existing dev server before running pnpm dev again.');
  process.exitCode = 1;
}
