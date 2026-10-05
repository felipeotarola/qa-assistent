import { defineChannel, POST } from 'eve/channels';
import { z } from 'zod';
import { internalHeaders } from '../lib/internal-api';
export default defineChannel({
  turnPolicy: 'queue',
  routes: [POST('/workers/mission-report/notify', async (request, { attachSession }) => {
    if (!process.env.INTERNAL_API_SECRET || request.headers.get('authorization') !== internalHeaders().authorization) return new Response('Unauthorized', { status: 401 });
    const body = z.object({ parentSessionId: z.string(), threadId: z.string().uuid(), userId: z.string().uuid(), reportId: z.string().uuid(), workspaceId: z.string().uuid(), summary: z.string().max(4000), stale: z.boolean() }).parse(await request.json());
    const receipt = await attachSession(body.parentSessionId).send(`Rapportmeddelande från Klara\n\n${body.summary}\n\n${body.stale ? 'Nya resultat har tillkommit efter rapportens lägesbild.\n\n' : ''}[Öppna den sparade rapporten](/reports/${body.reportId}?workspace=${body.workspaceId})`, { turnPolicy: 'queue', auth: { authenticator: 'app', issuer: 'app', principalType: 'user', principalId: body.userId, attributes: { browserThreadId: body.threadId, resultReviewNotification: 'true' } } });
    return Response.json({ ok: receipt.status === 'accepted' });
  })],
});
