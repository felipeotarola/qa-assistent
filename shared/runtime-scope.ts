import { hostname } from "node:os";

/** A workflow ID is only meaningful within the runtime that created it. */
export function runtimeScope() {
  if (process.env.PAT_RUNTIME_SCOPE?.trim()) return process.env.PAT_RUNTIME_SCOPE.trim();
  if (process.env.VERCEL_ENV === "production") return "production";
  if (process.env.VERCEL_ENV === "preview") return `preview:${process.env.VERCEL_URL}`;
  return `local:${hostname()}`;
}
