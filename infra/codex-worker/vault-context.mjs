import { allowedName } from './environment.mjs';

// Only names and repository identity enter the model context. Never spread input.
export function vaultContext(input) {
  if (!input || !Array.isArray(input.entries)) return 'Vault status was not checked. Do not claim credentials are absent.';
  const entries = input.entries.slice(0, 20).map(entry => ({
    repoUrl: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(entry?.repoUrl || '') ? entry.repoUrl : null,
    configuredNames: Array.isArray(entry?.configuredNames) ? entry.configuredNames.filter(name => typeof name === 'string' && allowedName(name)).slice(0, 30) : [],
  })).filter(entry => entry.repoUrl);
  return `Workspace vault inventory (metadata only, not runtime credentials): ${JSON.stringify({ entries, truncated: input.truncated === true || input.entries.length > 20 })}. Saved names mean values already exist in Vault, NOT that they are applied in this sandbox. Never ask the user to re-enter saved keys or read secrets from files. For app startup, call report_environment with the required variable names, including saved ones needed by the app, and the verified command/root/commit. Report saved-but-not-applied separately from missing keys. The user can approve application via Spara och fortsätt in Vault. No credential access is granted by this inventory.`;
}
