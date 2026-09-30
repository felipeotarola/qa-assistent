import { defineAgent, defineDynamic } from 'eve';
import { grundenModelSelection } from '../../lib/grunden';
export default defineAgent({
  description: 'Repository specialist: investigate project structure, choose Node/Java/Python checks, run custom commands or local apps in the shared VPS sandbox, and coordinate bounded repository jobs. Return exact commands, commits, saved run IDs and observed outcomes.',
  model: defineDynamic({ events: { 'step.started': (_event, ctx) => grundenModelSelection(ctx.session.auth.current?.attributes.chatModel, ctx.session.auth.current?.attributes.reasoning) } }),
});
