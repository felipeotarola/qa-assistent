# Agent context and latency

Keep permanent safety and evidence rules in instructions. Longer procedures live
in Eve skills, advertised by description and loaded with `load_skill` when needed:

- `workspace-authoring`: documents, embedded images, tables and diagrams.
- `test-plans`: requirements, execution, review and QA publication.
- `external-workspaces`: Linear/GitHub discovery and requested writes.

Do not remove authorization checks or tool schemas to save tokens. Skill loading
does not grant permissions. QA invariants remain always present, and the server
continues enforcing ownership, versions and publication workflows.

Simple repository status/known commands use the root tool; use the repo specialist
when investigation warrants a separate context. Avoid polling through model turns
and unnecessary suggestion calls for routine acknowledgements. Repository tool
responses bound log tails; UI/storage retain complete output.

## Measurement

On 2026-09-30 the earlier repository trace started at 17,985 input tokens. After
moving procedures and simplifying the repository schema, a fresh repository-status
smoke run started at 15,200 tokens (about 15.5% lower).
These are real provider usage values, but not identical prompts or a controlled
latency benchmark. The edited instruction/tool-description sections decreased by
about 12,000 characters; that is not an exact tokenizer count. Tool schemas and
other framework context still contribute substantially to input size.

Skills add a model/tool step when first needed. This trades a smaller baseline for
task-specific retrieval, not guaranteed faster execution of every individual task.
Provider queueing, tool I/O and model round trips must be measured separately.

The smoke trace also exposed invalid repository calls using specialist arguments
(`message`/`outputSchema`). A top-level object schema with an explicit `action`
avoids that confusion; the shared discriminated union still validates inputs
before execution. The final status smoke test took two model steps, versus three
to five with invalid-argument retries before this schema change.

Run the opt-in smoke test with `RUN_AGENT_CONTEXT_TESTS=1` and
`node --env-file=.env tests/agent-context.integration.mjs` against local Nuxt.
It uses real model calls and temporary account/workspace data, verifies direct
repository status and skill-backed document creation, then cleans up the account.
Unit coverage for bounded tool output: `node --test tests/repository-context.test.mjs`.

Simple-question smoke test: set `RUN_AGENT_SIMPLE_TESTS=1` and run
`node --env-file=.env tests/agent-simple-questions.integration.mjs`. It tests a
greeting, a general QA explanation and rewriting supplied text in separate fresh
chats, asserting one model step and no tool calls. Results are saved locally to
`.eve/simple-question-timing.json` (ignored by Git).

On 2026-09-30, with local Nuxt and remote Grunden Flash/low, these three samples
took 3.25–3.64 seconds to the first text event and 4.61–4.85 seconds until the client
result completed. First text uses the server event timestamp relative to the
client request start, not browser paint timing. Account/workspace setup is outside
the measurement. All three used zero tools; these are samples, not production
percentiles or a controlled before/after latency comparison.
