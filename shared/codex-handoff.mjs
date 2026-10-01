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
      content: 'The Codex job is running independently in the background. End this turn now with a brief acknowledgement that the user can continue chatting while progress appears in the Pågående arbete panel. Do not wait, poll, call tools, claim completion, or claim readiness. The registered setup job sends a background report when it ends. Missing configuration is filled in through the project environment form; authorized testing resumes only after verified readiness.',
    }],
  };
}
