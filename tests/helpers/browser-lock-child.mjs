import { isolatedApp } from './isolated-app.mjs';

// Only launched by browser-lock.integration inside the validated local fixture.
const app = await isolatedApp();
try {
  const { createBrowserLockManager } = await import('../../server/utils/browser-lock.ts');
  const manager = createBrowserLockManager(app.sql, { waitMs: 100, operationMs: 3000 });
  try {
    await manager.run(process.argv[2], async () => { process.send({ state: 'acquired' }); });
    process.send({ state: 'completed' });
  } catch (error) { process.send({ state: 'rejected', status: error.statusCode }); }
} finally { await app.close(); process.disconnect(); }
