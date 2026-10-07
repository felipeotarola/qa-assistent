import http from 'node:http';
import { pathToFileURL } from 'node:url';

const pages = {
  '/': ['Serviceguiden', 'Välkommen till vår serviceguide. Här finns hjälp och kontaktuppgifter.'],
  '/hjalp': ['Hjälp', 'Du kan besöka receptionen vardagar klockan 10–18.'],
  '/kontakt': ['Kontakt', 'Kontakta receptionen på reception@example.test.'],
};
export function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    const page = pages[new URL(req.url, 'http://localhost').pathname];
    res.statusCode = page ? 200 : 404;
    res.end(req.method === 'HEAD' ? '' : `<!doctype html><html lang="sv"><meta charset="utf-8"><title>${page?.[0] ?? 'Sidan saknas'}</title><body><header><nav aria-label="Huvudnavigering"><a href="/">Hem</a> <a href="/hjalp">Hjälp</a> <a href="/kontakt-old">Kontakt</a></nav></header><main><h1>${page?.[0] ?? 'Sidan saknas'}</h1><p>${page?.[1] ?? 'Vi hittar inte den här sidan.'}</p>${page ? '' : '<a href="/">Till startsidan</a>'}</main></body></html>`);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createServer().listen(3000, '0.0.0.0');
