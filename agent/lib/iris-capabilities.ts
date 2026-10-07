type Caller = { attributes?: Readonly<Record<string, unknown>> } | null | undefined;
type CallerContext = { session: { auth: { current?: Caller; initiator?: Caller } } };

export const IRIS_TOOL_NAMES = ['browser', 'workspace', 'test_run', 'load_skill'] as const;
// Only local built-ins can be replaced through Eve dynamic tools. `agent`,
// declared subagents and task controls carry runtimeAction metadata and Eve
// rejects a dynamic name collision before invoking the model. Delegation and
// Workflow remain forbidden by the provider-output guard and child admission.
export const IRIS_DENIED_LOCAL_TOOLS = ['bash', 'read_file', 'write_file', 'todo', 'web_fetch', 'ask_question'] as const;
export const IRIS_CAPABILITY_DENIED = 'Iris may only use browser, test_run and assigned workspace reads. Return other needs to the mission controller.';
export function isIrisSession(ctx: CallerContext) {
  return ctx.session.auth.current?.attributes?.browserWorker === 'iris' || ctx.session.auth.initiator?.attributes?.browserWorker === 'iris';
}
export function denyIrisCapability(ctx: CallerContext) {
  if (isIrisSession(ctx)) throw new Error(IRIS_CAPABILITY_DENIED);
}
/** Enforce the capability ceiling on provider output as well as advertised
 * schemas. A fabricated/old tool name must not reach Eve's fallback executor. */
export function assertIrisToolOutput(part: { type: string; toolName?: string; providerExecuted?: boolean }) {
  if (['tool-call', 'tool-input-start', 'tool-result'].includes(part.type) && (part.providerExecuted || !IRIS_TOOL_NAMES.some(name => name === part.toolName))) throw new Error(IRIS_CAPABILITY_DENIED);
}
