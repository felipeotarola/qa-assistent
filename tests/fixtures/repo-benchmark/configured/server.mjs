import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function createServer(environment = process.env) {
  const ready = ['SERVICE_BASE_URL', 'SERVICE_ACCESS_TOKEN'].every(name => typeof environment[name] === 'string' && environment[name].trim());
  return http.createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    const path = new URL(req.url, 'http://localhost').pathname;
    const page = ready ? { '/': ['Serviceportalen', 'Konfiguration kontrollerad. Välkommen till serviceportalen.'], '/hjalp': ['Hjälp', 'Besök receptionen vardagar klockan 10–18.'] }[path] : null;
    res.statusCode = !ready ? 503 : page ? 200 : 404;
    res.end(req.method === 'HEAD' ? '' : `<!doctype html><html lang="sv"><meta charset="utf-8"><title>${!ready ? 'Konfiguration saknas' : page?.[0] ?? 'Sidan saknas'}</title><body><nav aria-label="Huvudnavigering"><a href="/">Hem</a> <a href="/hjalp">Hjälp</a></nav><main><h1>${!ready ? 'Konfiguration saknas' : page?.[0] ?? 'Sidan saknas'}</h1><p>${!ready ? 'Båda serviceinställningarna behövs innan appen kan användas.' : page?.[1] ?? 'Vi hittar inte den här sidan.'}</p></main></body></html>`);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createServer().listen(3000, '0.0.0.0');
