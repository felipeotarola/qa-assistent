import { defineDynamic, defineTool } from 'eve/tools';
import { z } from 'zod';
import { isIrisSession, IRIS_CAPABILITY_DENIED, IRIS_DENIED_LOCAL_TOOLS } from '../lib/iris-capabilities';

// Deny only replaceable local built-ins at the executor. Runtime delegation
// names cannot be shadowed; the provider-output gate rejects those calls.
function restrictions(ctx: Parameters<typeof isIrisSession>[0]) {
  return isIrisSession(ctx) ? Object.fromEntries(IRIS_DENIED_LOCAL_TOOLS.map(name => [name, defineTool({
    description: 'Unavailable in an Iris browser assignment.',
    inputSchema: z.unknown(),
    execute() { throw new Error(IRIS_CAPABILITY_DENIED); },
  })])) : null;
}
export default defineDynamic({ events: {
  'session.started': (_event, ctx) => restrictions(ctx),
  'turn.started': (_event, ctx) => restrictions(ctx),
} });
