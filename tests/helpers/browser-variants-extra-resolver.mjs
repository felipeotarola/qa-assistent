import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { assertIsolatedDatabaseUrl } from './autonomy-isolation.mjs';

if (process.env.SYNA_BROWSER_EXTRA_VARIANTS !== 'fixture-v1' || !/^autonomy-test:[a-z0-9-]+$/.test(process.env.PAT_RUNTIME_SCOPE || '')
  || process.env.VERCEL || process.env.BROWSER_SERVICE_URL !== 'http://127.0.0.1:58092') throw new Error('Extra browser variants require explicit isolated configuration');
assertIsolatedDatabaseUrl(process.env.DATABASE_URL);
const matches = host => typeof host === 'string' && ['qa-regression.test', 'qa-auth.test'].includes(host.toLowerCase().replace(/\.$/, ''));
const address = '192.0.2.12', missingV6 = () => Object.assign(new Error('No IPv6 fixture address'), { code: 'ENOTFOUND' });
const original = dns.lookup.bind(dns), originalPromise = dnsPromises.lookup.bind(dnsPromises);
dns.lookup = (host, options, callback) => {
  if (!matches(host)) return original(host, options, callback);
  if (typeof options === 'function') { callback = options; options = {}; }
  const value = typeof options === 'number' ? { family: options } : options || {};
  queueMicrotask(() => value.family === 6 ? callback(missingV6()) : value.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4));
};
dnsPromises.lookup = async (host, options) => {
  if (!matches(host)) return originalPromise(host, options);
  const value = typeof options === 'number' ? { family: options } : options || {};
  if (value.family === 6) throw missingV6(); return value.all ? [{ address, family: 4 }] : { address, family: 4 };
};
syncBuiltinESMExports();
