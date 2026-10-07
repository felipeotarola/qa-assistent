// Dedicated GAP13 target. Fixture semantics are not supplied to the agent.
// The public UI contains the catalog; the agent must choose its own queries.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const products = [{ name: 'Björklykta', category: 'Belysning' }, { name: 'Stenfat', category: 'Servering' }, { name: 'Ullpläd', category: 'Textil' }];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function evidenceSearchPage(path) {
  const url = new URL(path, 'http://evidence.test');
  if (!['/', '/search'].includes(url.pathname)) return { status: 404, body: 'Sidan finns inte.' };
  const query = url.searchParams.get('q') ?? '', searched = url.pathname === '/search' && url.searchParams.has('q');
  if (query.length > 200) return { status: 400, body: 'Sökfrasen är för lång.' };
  const results = products.filter(p => `${p.name} ${p.category}`.toLocaleLowerCase('sv').includes(query.toLocaleLowerCase('sv').trim()));
  const body = `<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skog & sten – sök i sortimentet</title>
<style>body{font:18px/1.6 system-ui;margin:3rem auto;max-width:48rem;padding:0 1rem;color:#18302a;background:#fafaf6}header{border-bottom:1px solid #abc}label{display:block}input,button{font:inherit;padding:.65rem}input{width:60%}button{background:#17483b;color:white;border:0}li{margin:1rem 0}a{color:#17483b}</style>
<header><a href="/">Skog & sten</a><p>Sök bland våra produkter efter namn eller kategori.</p></header><main><h1>Hitta i sortimentet</h1>
<form method="get" action="/search"><label for="q">Sök produkt eller kategori</label><input id="q" name="q" type="search" maxlength="200" value="${escape(query)}"><button type="submit">Sök</button></form>
${searched ? `<section aria-live="polite"><h2>Sökresultat</h2><p>Sökning: <strong>${escape(query)}</strong></p>${results.length ? `<p>${results.length} träff${results.length === 1 ? '' : 'ar'}</p><ul>${results.map(p => `<li><h3>${p.name}</h3><p>${p.category}</p></li>`).join('')}</ul>` : '<p>Inga produkter matchar din sökning. Prova ett annat namn eller en annan kategori.</p>'}</section>` : `<section><h2>Vårt sortiment</h2><ul>${products.map(p => `<li><h3>${p.name}</h3><p>${p.category}</p></li>`).join('')}</ul></section>`}
</main></html>`;
  return { status: 200, body };
}
export function evidenceSearchHandler(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
  const result = evidenceSearchPage(req.url); res.writeHead(result.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" });
  res.end(req.method === 'HEAD' ? undefined : result.body);
}
// Opt-in deployment is the runtime owner's responsibility. Import is inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--serve')) throw new Error('Explicit --serve is required');
  const port = Number(process.argv.find(a => a.startsWith('--port='))?.slice(7));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Explicit unprivileged port required');
  createServer(evidenceSearchHandler).listen(port, '127.0.0.1');
}
