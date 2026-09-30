import { defineAgent, defineDynamic } from 'eve';
import { grundenModelSelection } from '../../lib/grunden';
export default defineAgent({
  description: 'Inspect repositories and coordinate isolated npm test runs. Return saved run IDs, exact commits, command outcomes and missing prerequisites.',
  model: defineDynamic({ events: { 'step.started': (_event, ctx) => grundenModelSelection(ctx.session.auth.current?.attributes.chatModel, ctx.session.auth.current?.attributes.reasoning) } }),
});
