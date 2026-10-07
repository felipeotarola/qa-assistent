import { defineAgent, defineDynamic } from "eve";
import { grundenModelSelection } from "./lib/grunden";
import { codexTurn } from './lib/codex-turn';
import { assertIrisAdmission, withIrisModelBudget } from './lib/iris-admission';

export default defineAgent({
  model: defineDynamic({
    events: {
      // Direct provider objects are supported at step scope. The authenticated
      // turn carries the choice, so all tool steps use that turn's model.
      "step.started": async (event, ctx) => {
        await assertIrisAdmission(event, ctx);
        const selection = grundenModelSelection(
        ctx.session.auth.current?.attributes.chatModel,
        ctx.session.auth.current?.attributes.reasoning,
        !!codexTurn.get().turnId,
        ctx.session.auth.current?.attributes.browserWorker === 'iris',
        ctx.session.auth.current?.attributes.resultReviewNotification === 'true' || ctx.session.auth.current?.attributes.browserNotification === 'iris' || ctx.session.auth.current?.attributes.setupNotification === 'blocked',
        );
        return { ...selection, model: withIrisModelBudget(selection.model, event, ctx) };
      },
    },
  }),
});
