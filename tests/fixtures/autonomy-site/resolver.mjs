import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { assertIsolatedDatabaseUrl } from '../../helpers/autonomy-isolation.mjs';

// Loaded only by an explicit --import in the isolated acceptance process.
// Research performs DNS policy checks here, but remote Chromium fetches the page.
if (process.env.SYNA_AUTONOMY_SITE !== 'fixture-v1'
  || !/^autonomy-test:[a-z0-9-]+$/.test(process.env.PAT_RUNTIME_SCOPE || '')
  || process.env.VERCEL
  || process.env.BROWSER_SERVICE_URL !== 'http://127.0.0.1:58092') {
  throw new Error('The autonomy fixture resolver requires the explicitly isolated runtime/browser.');
}
assertIsolatedDatabaseUrl(process.env.DATABASE_URL);
const hostname = 'qa-fixture.test';
const address = '192.0.2.10';
const matches = host => typeof host === 'string' && host.toLowerCase().replace(/\.$/, '') === hostname;
const result = options => options?.all ? [{ address, family: 4 }] : { address, family: 4 };
const missingV6 = () => Object.assign(new Error('No IPv6 address for the fixture'), { code: 'ENOTFOUND', hostname });
const originalLookup = dns.lookup.bind(dns);
dns.lookup = (host, options, callback) => {
  if (!matches(host)) return originalLookup(host, options, callback);
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : options || {};
  queueMicrotask(() => opts.family === 6 ? callback(missingV6()) : opts.all ? callback(null, result(opts)) : callback(null, address, 4));
};
const originalPromiseLookup = dnsPromises.lookup.bind(dnsPromises);
dnsPromises.lookup = async (host, options) => {
  if (!matches(host)) return originalPromiseLookup(host, options);
  const opts = typeof options === 'number' ? { family: options } : options || {};
  if (opts.family === 6) throw missingV6();
  return result(opts);
};
syncBuiltinESMExports();
