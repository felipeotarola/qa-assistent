import { defineAgent, defineDynamic } from "eve";
import { grundenModelSelection } from "./lib/grunden";

export default defineAgent({
  model: defineDynamic({
    events: {
      // Direct provider objects are supported at step scope. The authenticated
      // turn carries the choice, so all tool steps use that turn's model.
      "step.started": (_event, ctx) => grundenModelSelection(
        ctx.session.auth.current?.attributes.chatModel,
        ctx.session.auth.current?.attributes.reasoning,
      ),
    },
  }),
});
