import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Immutable, offline acceptance website. The oracle is not served to visitors.
const revision = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const escape = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const products = [
  { name: 'Bryggkaffe', description: 'Mellanrostat kaffe, 500 g', price: '79 kr' },
  { name: 'Havrete', description: 'Rostat örtte, 100 g', price: '49 kr' },
  { name: 'Frukostmugg', description: 'Vit stengodsmugg, 30 cl', price: '119 kr' },
];
const layout = (title, body) => `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Björk & Böna: kaffe, te och tillbehör för en lugn morgon."><title>${escape(title)} | Björk & Böna</title><style>body{font:18px/1.6 system-ui,sans-serif;color:#183a32;background:#f7f7ef;margin:0}header,main,footer{max-width:960px;margin:auto;padding:24px}header{display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid #cbd5c8}nav{display:flex;gap:20px;flex-wrap:wrap}a{color:#13583e}main{min-height:60vh}h1{font-size:36px;line-height:1.2}input,button{font:inherit;padding:10px 16px;border:1px solid #789087;border-radius:6px}button{background:#164f3b;color:white;cursor:pointer}label{display:block}ul{padding:0;list-style:none}li{padding:18px;background:white;border:1px solid #dde4d9;margin:14px 0}footer{border-top:1px solid #cbd5c8;font-size:14px}</style></head><body><header><a href="/">Björk & Böna</a><nav aria-label="Huvudnavigation"><a href="/products">Produkter</a><a href="/returns">Returer</a><a href="/contact">Kontakt</a></nav></header><main>${body}</main><footer>© Björk & Böna · Webbversion 1.0</footer></body></html>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://qa-fixture.test');
  let status = 200;
  let title = 'Välkommen';
  let body;
  if (!['GET', 'HEAD'].includes(request.method)) {
    status = 405; title = 'Metoden stöds inte'; body = '<h1>Metoden stöds inte</h1>';
  } else if (url.pathname === '/') {
    body = '<h1>En lugn morgon börjar här</h1><p>Upptäck vårt kaffe, te och tillbehör. Läs mer om våra produkter eller kontakta oss om du har frågor.</p><p><a href="/products">Se alla produkter</a></p><form action="/products" method="get"><label for="search">Sök bland våra produkter</label><input id="search" name="q" type="search" placeholder="Till exempel kaffe"><button type="submit">Sök</button></form>';
  } else if (url.pathname === '/products') {
    title = 'Produkter';
    const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
    const found = products.filter(product => `${product.name} ${product.description}`.toLocaleLowerCase('sv').includes(query.toLocaleLowerCase('sv')));
    body = `<h1>Våra produkter</h1><form action="/products" method="get"><label for="search">Sök produkt</label><input id="search" name="q" type="search" value="${escape(query)}"><button type="submit">Sök</button></form><p>${found.length} produkter${query ? ` för ”${escape(query)}”` : ''}</p><ul>${found.map(product => `<li><h2>${product.name}</h2><p>${product.description}</p><p>${product.price}</p></li>`).join('')}</ul>${found.length ? '' : '<p>Vi hittade inga produkter. Prova ett annat sökord.</p>'}`;
  } else if (url.pathname === '/contact') {
    title = 'Kontakt'; body = '<h1>Kontakta oss</h1><p>Vi hjälper dig med frågor om produkter och leveranser.</p><h2>Öppettider</h2><p>Måndag–fredag 09.00–16.00.</p><p>Du hittar svar på vanliga returfrågor under <a href="/returns">Returer</a>.</p><p><a href="/">Till startsidan</a></p>';
  } else {
    // Deliberate known product defect: the visible Returns link has no page.
    status = 404; title = 'Sidan hittades inte'; body = '<h1>Sidan hittades inte</h1><p>Vi kunde inte hitta sidan du söker.</p><p><a href="/">Till startsidan</a></p>';
  }
  const html = layout(title, body);
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-fixture-sha256': revision, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  response.end(request.method === 'HEAD' ? undefined : html);
});
server.listen(80, '0.0.0.0');
process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); });
