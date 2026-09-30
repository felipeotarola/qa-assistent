import { randomUUID } from 'node:crypto';
import type { SandboxBackend, SandboxSession } from 'eve/sandbox';
import { appOrigin, internalHeaders } from './internal-api';

type Scope = { userId: string; threadId: string };
type ProcessState = { id: string; status: string; stdout: string; stderr: string; exitCode: number | null };
const pause = () => new Promise(resolve => setTimeout(resolve, 500));
async function outputTail(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let tail = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return (tail + decoder.decode()).slice(-64000);
    tail = (tail + decoder.decode(value, { stream: true })).slice(-64000);
  }
}
export const vpsSandbox: SandboxBackend<Record<string, never>, Scope> = {
  name: 'qaa-vps-v1',
  async prewarm({ bootstrap, seedFiles }) {
    if (bootstrap || seedFiles.length) throw new Error('VPS sandbox templates are not supported. Put reusable tools in the worker image.');
    return { reused: true };
  },
  async create({ sessionKey, existingMetadata }) {
    let scope = existingMetadata?.scope as Scope | undefined;
    let generation = typeof existingMetadata?.generation === 'string' ? existingMetadata.generation : '';
    let stateLost = false;
    const environmentKey = () => generation ? `${sessionKey}:${generation}` : sessionKey;
    let ready = false;
    async function rpc<T>(input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      if (!scope?.userId || !scope.threadId) throw new Error('VPS sandbox requires an authenticated workspace chat.');
      const response = await fetch(`${appOrigin()}/api/internal/sandbox`, { method: 'POST', headers: internalHeaders(), body: JSON.stringify({ ...scope, sessionKey: environmentKey(), input }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { statusMessage?: string };
        throw new Error(error.statusMessage || 'VPS sandbox request failed. No fallback environment was started.');
      }
      return response.json() as Promise<T>;
    }
    async function ensure() {
      if (ready) return;
      for (let attempts = 0; attempts < 20; attempts++) {
        try { await rpc({ action: 'ensure' }); ready = true; return; }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('Sandbox lease ended.')) throw error;
          const previous = await rpc<{ id: string }>({ action: 'status' });
          // Parent and child may reattach from the same older checkpoint. Derive
          // the successor from the expired ID so both find one environment,
          // even before Eve commits the owner's new sandbox metadata.
          generation = previous.id; stateLost = true;
        }
      }
      throw new Error('Too many expired sandbox generations. Start a new chat environment.');
    }
    const session: SandboxSession = {
      get id() { return environmentKey(); },
      resolvePath(path) { return path.startsWith('/') ? path : `/workspace/${path.replace(/^\$HOME\//, '')}`; },
      async spawn(options) {
        await ensure(); options.abortSignal?.throwIfAborted();
        const processId = randomUUID();
        await rpc({ action: 'spawn', processId, command: options.command, workingDirectory: options.workingDirectory, env: options.env }, options.abortSignal);
        let stdoutController: ReadableStreamDefaultController<Uint8Array>, stderrController: ReadableStreamDefaultController<Uint8Array>;
        const stdout = new ReadableStream<Uint8Array>({ start(controller) { stdoutController = controller; }, pull() { void wait().catch(() => {}); } }, { highWaterMark: 0 });
        const stderr = new ReadableStream<Uint8Array>({ start(controller) { stderrController = controller; }, pull() { void wait().catch(() => {}); } }, { highWaterMark: 0 });
        const kill = async () => { await rpc({ action: 'kill', processId }); };
        const onAbort = () => { void kill().catch(() => {}); };
        options.abortSignal?.addEventListener('abort', onAbort, { once: true });
        const monitor = async () => {
          let previousOut = '', previousError = '';
          try {
            for (;;) {
              options.abortSignal?.throwIfAborted();
              const state = await rpc<ProcessState>({ action: 'process', processId });
              // Process output is bounded. A full buffer marks a tail replacement.
              for (const [value, previous, controller] of [[state.stdout, previousOut, stdoutController!], [state.stderr, previousError, stderrController!]] as const) {
                const delta = value.startsWith(previous) ? value.slice(previous.length) : `\n[Earlier output truncated]\n${value}`;
                if (delta) { try { controller.enqueue(new TextEncoder().encode(delta)); } catch { /* Reader cancelled. */ } }
              }
              previousOut = state.stdout; previousError = state.stderr;
              if (state.status === 'interrupted') throw new Error('Worker interrupted the process; it was not replayed.');
              if (state.status === 'completed') return { exitCode: state.exitCode ?? 137 };
              await pause();
            }
          } finally {
            options.abortSignal?.removeEventListener('abort', onAbort);
            try { stdoutController!.close(); } catch { /* Closed reader. */ }
            try { stderrController!.close(); } catch { /* Closed reader. */ }
          }
        };
        let result: Promise<{ exitCode: number }> | undefined;
        function wait() { return result ||= monitor(); }
        return { stdout, stderr, wait, kill };
      },
      async run(options) {
        const process = await session.spawn(options);
        const [stdout, stderr, result] = await Promise.all([outputTail(process.stdout), outputTail(process.stderr), process.wait()]);
        const warning = stateLost ? '[The previous VPS environment expired. This is a NEW empty environment; old files and processes were not restored.]\n' : '';
        stateLost = false;
        return { ...result, stdout: warning + stdout, stderr };
      },
      async readBinaryFile(options) {
        await ensure();
        const result = await rpc<{ data: string | null }>({ action: 'read', path: session.resolvePath(options.path) }, options.abortSignal);
        return result.data === null ? null : new Uint8Array(Buffer.from(result.data, 'base64'));
      },
      async readFile(options) { const bytes = await session.readBinaryFile(options); return bytes === null ? null : new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }); },
      async readTextFile(options) {
        const bytes = await session.readBinaryFile(options); if (bytes === null) return null;
        const text = Buffer.from(bytes).toString((options.encoding || 'utf8') as BufferEncoding);
        return options.startLine || options.endLine ? text.split('\n').slice((options.startLine || 1) - 1, options.endLine).join('\n') : text;
      },
      async writeBinaryFile(options) { await ensure(); await rpc({ action: 'write', path: session.resolvePath(options.path), data: Buffer.from(options.content).toString('base64') }, options.abortSignal); },
      async writeTextFile(options) { await session.writeBinaryFile({ ...options, content: Buffer.from(options.content, (options.encoding || 'utf8') as BufferEncoding) }); },
      async writeFile(options) { const content = new Uint8Array(await new Response(options.content).arrayBuffer()); await session.writeBinaryFile({ ...options, content }); },
      async removePath(options) { await ensure(); await rpc({ action: 'remove', path: session.resolvePath(options.path), recursive: options.recursive, force: options.force }, options.abortSignal); },
      async setNetworkPolicy() { throw new Error('The VPS worker enforces public internet only. Dynamic network-policy changes are not supported.'); },
    };
    const stop = async () => { if (scope) { await rpc({ action: 'stop' }); ready = false; } };
    return {
      session,
      async useSessionFn(options) { if (options) scope = options; await ensure(); return session; },
      async captureState() { return { backendName: 'qaa-vps-v1', sessionKey, metadata: { scope, generation } }; },
      async delete(options) { await rpc({ action: 'delete' }, options?.abortSignal); ready = false; },
      stop, shutdown: stop,
    };
  },
};
