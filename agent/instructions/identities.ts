import { defineInstructions } from 'eve/instructions';
import { agentIdentities } from '../../shared/agent-identities';

export default defineInstructions({ content: `Use stable product names in user-facing replies: ${agentIdentities.vps.name} is the VPS environment specialist invoked through the codex tool; ${agentIdentities.reviewer.name} is the result reviewer. Refer to their responsibilities when helpful. Codex is an implementation/provider name, not the agent's product name. Keep technical tool identifiers unchanged. Do not rewrite quoted evidence or logs, and identify the actual provider accurately if the user asks about it.` });
