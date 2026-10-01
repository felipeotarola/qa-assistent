import { z } from 'zod';
import { destinations } from '../../../utils/external';
import { readLinearProject } from '../../../utils/linear-workspace';
import { mintUserToken } from '../../../utils/connect';
import { getConnector } from '../../../connectors';

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const userId = await requireSessionUserId(event);
  const destination = (await destinations(userId, getRouterParam(event, 'id')!)).find(d => d.provider === 'linear');
  if (!destination?.projectId) throw createError({ statusCode: 400, statusMessage: 'Choose a Linear project in workspace connections.' });
  const cursors = z.object({ issues: z.string().max(300).optional(), documents: z.string().max(300).optional() }).parse(getQuery(event));
  let token: string;
  try { token = await mintUserToken(getConnector('linear'), userId); }
  catch { throw createError({ statusCode: 424, statusMessage: 'Reconnect Linear in Settings > Integrations.' }); }
  return { project: await readLinearProject(token, destination, cursors), fetchedAt: new Date().toISOString() };
});
