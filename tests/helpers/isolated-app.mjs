import { existsSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as h3 from 'h3';
import { assertIsolatedDatabaseUrl } from './autonomy-isolation.mjs';

/** Real SQL + authored server modules; no default app environment is loaded. */
export async function isolatedApp() {
  const url = assertIsolatedDatabaseUrl(process.env.DATABASE_URL);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@nuxthub/db') return { url: 'data:text/javascript,export const db = globalThis.autonomyTestDb; export const schema = globalThis.autonomyTestSchema;', shortCircuit: true };
    if (specifier.startsWith('#shared/') && context.parentURL?.startsWith('file:') && !context.parentURL.includes('/node_modules/')) {
      const target = new URL(`../../shared/${specifier.slice(8)}`, import.meta.url);
      const url = existsSync(fileURLToPath(target)) ? target : new URL(`${target.href}.ts`);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  } });
  const schema = {};
  for (const file of readdirSync(new URL('../../server/db/schema/', import.meta.url)).filter(name => name.endsWith('.ts'))) Object.assign(schema, await import(`../../server/db/schema/${file}`));
  const sql = postgres(url, { prepare: false, max: 6, connection: { TimeZone: 'UTC' } });
  const db = drizzle(sql);
  Object.assign(globalThis, { autonomyTestDb: db, autonomyTestSchema: schema,
    ...Object.fromEntries(['createError', 'defineEventHandler', 'readBody', 'readValidatedBody', 'getRequestHeader', 'getRouterParam', 'setHeader', 'sendStream'].map(key => [key, h3[key]])) });
  return { sql, db, schema, async close() { await sql.end(); hooks.deregister(); } };
}
