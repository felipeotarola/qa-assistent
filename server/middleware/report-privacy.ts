export default defineEventHandler(event => {
  const path = getRequestURL(event).pathname;
  if (path.startsWith('/reports/') || path.startsWith('/api/report-shares/')) setHeaders(event, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
});
