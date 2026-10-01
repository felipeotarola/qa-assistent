import { defineDynamic, defineInstructions } from 'eve/instructions';

export default defineDynamic({ events: {
  'session.started': (_event, ctx) => defineInstructions({ markdown:
    process.env.CODEX_PILOT_USER_ID && ctx.session.auth.current?.principalId === process.env.CODEX_PILOT_USER_ID
      ? 'This caller has enabled the Codex subscription pilot. For repository installation, starting a local application, or diagnosing setup failures, delegate with codex(action: start, task). Include the user goal and any observed paths/revisions. Codex operates inside your shared VPS sandbox and inspects it before changes. Do not duplicate its work with bash, repository or another specialist while it is active. After starting a background job, acknowledge it briefly and end your turn immediately so the user can keep chatting. Never poll or wait for it, including with bash. Use codex status only on a later user request to read verified results; a submitted task is not completion. Open preview for a verified running port after completion. Keep the normal browser tools for browser-only tasks and repository for explicit bounded checks. The open workspace displays completion summaries automatically above the composer and details in Pågående arbete. Registered setup jobs send a background report to this chat. Missing configuration requires the project environment form. After verified HTTP readiness, continue only the originally authorized tests. Do not promise automatic retries.'
      : 'The Codex subscription worker is an owner-only opt-in pilot. Do not select it automatically for this caller. Use the existing repository and sandbox tools.',
  }),
} });
