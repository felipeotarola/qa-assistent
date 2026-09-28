import { ConnectionAuthorizationRequiredError, defineMcpClientConnection } from "eve/connections";
import { appOrigin, internalHeaders } from "../lib/internal-api";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp/readonly",
  description: "Linear workspace: issues, projects, cycles, and comments. Connect your own Linear account in Settings > Integrations first. Writes use the external tool.",
  auth: {
    principalType: "user",
    async getToken({ principal }) {
      if (principal.type !== "user") throw new ConnectionAuthorizationRequiredError("linear");
      const response = await fetch(`${appOrigin()}/api/internal/linear-token`, { method: "POST", headers: internalHeaders(), body: JSON.stringify({ userId: principal.id }), signal: AbortSignal.timeout(20000) });
      if (response.status === 409) throw new ConnectionAuthorizationRequiredError("linear", { message: "Connect Linear in Settings > Integrations, then retry." });
      if (!response.ok) throw new Error("Could not load Linear connection");
      return await response.json() as { token: string };
    },
  },
});
