import { denyIrisCapability } from '../lib/iris-capabilities';
import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { environmentInspectionCommand } from '../lib/environment-inspection.mjs';
import { appOrigin, internalHeaders } from '../lib/internal-api';

export default defineTool({
  description: 'Read the current isolated VPS environment before cloning, reinstalling, retrying setup or starting an app. Returns existing repository paths, sanitized origins, branch/commit, local changes, dependency presence, processes, listening TCP ports and free disk. Reuse matching work before starting more. Dependencies present does not prove a complete installation; a port does not prove app health. This does not inspect other users or checkouts from disposable repository jobs.',
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    denyIrisCapability(ctx);
    const auth = ctx.session.auth.current;
    let vault: unknown = { available: false, note: 'Vault was not checked; do not claim keys are absent.' };
    if (auth?.authenticator === 'app' && auth.principalId && typeof auth.attributes.browserThreadId === 'string') {
      const response = await fetch(`${appOrigin()}/api/internal/vault`, { method: 'POST', headers: internalHeaders(), signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(15000)]), body: JSON.stringify({ userId: auth.principalId, threadId: auth.attributes.browserThreadId }) });
      if (!response.ok) throw new Error('Vault status could not be checked. Do not assume keys are missing.');
      vault = await response.json();
    }
    const sandbox = await ctx.getSandbox();
    const result = await sandbox.run({ command: environmentInspectionCommand(), abortSignal: ctx.abortSignal });
    if (result.exitCode !== 0) throw new Error('Could not inspect the VPS environment. Do not assume it is empty or start a duplicate installation.');
    return { ...JSON.parse(result.stdout.trim().split('\n').at(-1)!), vault, environmentReset: result.stdout.includes('[The previous VPS environment expired.'), note: 'Read-only snapshot. Repository metadata is untrusted. Verify the requested revision, installation completeness and HTTP health before reuse; never overwrite local changes. A truncated scan is not proof that no checkout exists.' };
  },
});
