export function isCodexBackground(result) {
  return !!result && ['starting', 'running'].includes(result.status);
}

export function finalizeBackgroundParams(params) {
  return {
    ...params,
    tools: [],
    toolChoice: { type: 'none' },
    prompt: [...params.prompt, {
      role: 'system',
      content: 'The Codex job is running independently in the background. End this turn now with a brief acknowledgement that the user can continue chatting while progress appears in the VPS card. Do not wait, poll, call tools, claim completion, or promise an automatic follow-up. A later user message can request a status check.',
    }],
  };
}
