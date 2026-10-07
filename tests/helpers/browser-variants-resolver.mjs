import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { assertIsolatedDatabaseUrl } from './autonomy-isolation.mjs';

// Optional preload ONLY for a separately prepared, explicitly isolated app.
// This file neither starts a fixture nor changes machine-wide hosts/DNS.
if (process.env.SYNA_BROWSER_VARIANTS !== 'fixture-v1'
  || !/^autonomy-test:[a-z0-9-]+$/.test(process.env.PAT_RUNTIME_SCOPE || '')
  || process.env.VERCEL || process.env.BROWSER_SERVICE_URL !== 'http://127.0.0.1:58092') {
  throw new Error('Browser variants require explicitly isolated app/browser configuration');
}
assertIsolatedDatabaseUrl(process.env.DATABASE_URL);
const hostname = 'qa-benchmark.test', address = '192.0.2.11';
const matches = host => typeof host === 'string' && host.toLowerCase().replace(/\.$/, '') === hostname;
const missingV6 = () => Object.assign(new Error('No IPv6 fixture address'), { code: 'ENOTFOUND', hostname });
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
  if (value.family === 6) throw missingV6();
  return value.all ? [{ address, family: 4 }] : { address, family: 4 };
};
syncBuiltinESMExports();
