import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import { createError } from 'h3';
import { db } from '@nuxthub/db';

type LockContext = { signal: AbortSignal; assert: () => Promise<void> };
const context = new AsyncLocalStorage<LockContext>();
const lost = () => createError({ statusCode: 409, statusMessage: 'Browser operation outcome unknown', message: 'Webbläsarens arbetslås tappades. Handlingen kan ha utförts; kontrollera utfallet innan nästa försök.' });

function lockClient(bound: postgres.Sql['options'], waitMs: number, operationMs: number, onclose: () => void) {
  const options = { ...bound, max: 1, prepare: false, idle_timeout: 0, connect_timeout: Math.min(bound.connect_timeout || 15, 15), max_lifetime: null,
    parameters: {}, shared: { retries: 0, typeArrayMap: {} },
    connection: { ...bound.connection, application_name: 'syna-browser-lock', statement_timeout: waitMs, idle_in_transaction_session_timeout: operationMs + waitMs },
    debug: false, onnotice: () => {}, onclose };
  // postgres-js 3.4 exposes ParsedOptions with host/port arrays. Its runtime
  // accepts this already-parsed form via `shared`, but the constructor's public
  // Options type describes unparsed input. Keep that boundary cast here only;
  // converting back to URL/unparsed input would reintroduce ambient env lookup.
  return postgres(options as unknown as postgres.Options<Record<string, never>>);
}

/** The connection is derived from the already bound database client, never a
 * second DATABASE_URL/env lookup. postgres-js exposes resolved options; its
 * shared marker preserves those parsed values rather than reparsing env. */
export function createBrowserLockManager(source: Pick<postgres.Sql, 'options'>, limits: { capacity?: number; waitMs?: number; operationMs?: number } = {}) {
  const capacity = limits.capacity ?? 4, waitMs = limits.waitMs ?? 10000, operationMs = limits.operationMs ?? 120000;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8 || !Number.isInteger(waitMs) || waitMs < 10 || waitMs > 30000
    || !Number.isInteger(operationMs) || operationMs < 50 || operationMs > 180000) throw new Error('Invalid bounded browser lock limits');
  const bound = source.options;
  if (!bound?.database || !bound.user || !bound.host?.length || !bound.port?.length || !('shared' in bound) || !('parameters' in bound)) throw new Error('Browser locks require the bound postgres-js client options');
  let active = 0;
  return {
    async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
      if (!key.startsWith('browser:') || key.length > 500) throw new Error('Invalid browser lock identity');
      if (active >= capacity) throw createError({ statusCode: 503, statusMessage: 'Webbläsarens arbetskö är upptagen. Inget nytt anrop utfördes.' });
      active++;
      const controller = new AbortController(); let acquired = false, finishing = false, operationFailure: unknown;
      // A bounded lock-only connection cannot starve the ordinary app pool.
      // BEGIN pins it even behind a transaction pooler. It never reads/writes
      // application tables or holds their FK/row locks during browser HTTP/CDP.
      const client = lockClient(bound, waitMs, operationMs, () => { if (!finishing) controller.abort(lost()); });
      // A blackholed socket may never emit close or finish its heartbeat. Force
      // this client's pending queries to reject when the operation expires;
      // the server-side idle timeout also bounds an orphaned lock transaction.
      const terminate = () => { void client.end({ timeout: 0 }).catch(() => {}); };
      controller.signal.addEventListener('abort', terminate, { once: true });
      try {
        const result = await client.begin(async lock => {
          await lock`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          acquired = true; controller.signal.throwIfAborted();
          const [identity] = await lock<{ pid: number }[]>`select pg_backend_pid() as pid`;
          if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw lost();
          const pid = identity.pid;
          const assert = async () => {
            controller.signal.throwIfAborted();
            try {
              const [current] = await lock<{ pid: number }[]>`select pg_backend_pid() as pid`;
              if (!current || current.pid !== pid) throw lost();
            } catch { controller.abort(lost()); }
            controller.signal.throwIfAborted();
          };
          const timer = setTimeout(() => controller.abort(lost()), operationMs); timer.unref();
          let heartbeat: Promise<void> = Promise.resolve();
          const interval = setInterval(() => { heartbeat = heartbeat.then(assert).catch(() => { controller.abort(lost()); }); }, 1000); interval.unref();
          let abort!: () => void;
          const interrupted = new Promise<never>((_, reject) => { abort = () => reject(controller.signal.reason ?? lost()); controller.signal.addEventListener('abort', abort, { once: true }); });
          try {
            return await Promise.race([context.run({ signal: controller.signal, assert }, async () => {
              try { const value = await operation(); await assert(); return { value }; }
              catch (error) { operationFailure = error; throw error; }
            }), interrupted]);
          } finally { clearTimeout(timer); clearInterval(interval); controller.signal.removeEventListener('abort', abort); await heartbeat; }
        });
        return result.value;
      } catch (error) {
        if (controller.signal.aborted || (acquired && error !== operationFailure)) { controller.abort(lost()); throw controller.signal.reason; }
        if (acquired) throw error;
        // Acquisition failure occurs before operation(), hence no physical effect.
        throw createError({ statusCode: 503, statusMessage: 'Webbläsarens arbetslås kunde inte tas inom tidsgränsen.', cause: error });
      } finally {
        finishing = true; controller.signal.removeEventListener('abort', terminate);
        try { await client.end({ timeout: 1 }); } finally { active--; }
      }
    },
  };
}

let manager: ReturnType<typeof createBrowserLockManager> | undefined;
export function withBrowserLock<T>(key: string, operation: () => Promise<T>) {
  manager ??= createBrowserLockManager(db.$client);
  return manager.run(key, operation);
}
export async function assertBrowserLock() { await context.getStore()?.assert(); }
export function browserLockSignal() { return context.getStore()?.signal; }
