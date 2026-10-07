# REPO-12 consent preparation, protocol 2

`tests/helpers/repo-prepare-consent-v2.mjs` creates separately measured fixture
history through normal owner APIs. It requests ordinary application QA using the
configured fixture, observes its real missing-configuration wait, cancels that
mission, waits for closure and physical cleanup, and only then stores synthetic
Vault values and grants consent for the exact saved plan. Later REPO-12 QA uses a
new chat and mission. The preparation is excluded from that QA's time and usage.

The old `repo-prepare-consent.mjs` is protocol 1. Its natural request was only to
prepare without starting. The product advertises a legacy setup tool for that
request, so requiring a controller mission was an incorrect harness assumption.
Do not recertify that failure or adopt its job into a new mission. Protocol 2 does
not add a product feature or reinterpret a preparation-only request as startup
authorization: its own new prompt explicitly requests normal QA from the start.

## Inputs and guards

- Use a fresh ordinary-user workspace with no setups, Vault values, consent,
  active mission or resource claim. The configured fixture really requires its
  two versioned configuration names; the names/oracle are never in the prompt.
- Require an actual controller-owned prepare receipt at the exact repo/commit,
  stopped executor, confirmed cleanup, committed completed task/attempt and a
  current configuration wait for that plan's waiting apply task. A saved plan
  alone is insufficient. No apply reservation, preview, browser or test may have
  started before the cancellation.
- Persist the ordinary cancellation's request ID before sending. Verify closure
  and cleanup before storing any dummy values or granting consent. Never answer
  the cancelled mission's wait or implicitly resume it.
- Require the same verified private web/Eve output, runtime, worker, transport,
  manifest bytes, helper hashes and provider pacing throughout preparation.
- Stop the series on the first failure. Keep the lock and partial artifact. No
  rescue prompt, direct SQL write or drain is permitted.

The v2 manifest is a **new sibling file** of its bound parent and `transport.json`.
It preserves the entire parent's JSON, adding only:

```json
{
  "preparationProtocol": {
    "version": 2,
    "sourceSha256": "<SHA256 of the intended authored app snapshot>",
    "callbackTransport": { "path": "<private relay receipt>", "sha256": "<receipt SHA256>" },
    "id": "<fresh UUID>",
    "parentManifest": "bound-manifest.json",
    "parentManifestSha256": "<SHA256 of that exact parent file>"
  }
}
```

The helper validates the parent identity, byte hash and exact authored snapshot
before any authentication or mutation. If an older failed run's
`consent-preparation.lock` remains, do not remove it to retry blindly. The
lifecycle owner must first observe that original run and its resources have
settled, then archive that exact lock with its failed-run identity, preserving
both history and the original artifact. Preparations sharing a fixture directory
are serial; the new helper uses the same exclusive lock.

```powershell
pnpm.cmd exec node tests/helpers/repo-prepare-consent-v2.mjs --validate --manifest=<new-v2-manifest>
```

Validation is filesystem-only. `--execute` makes real model requests and ordinary
API writes and needs a separately coordinated isolated runtime window. It does
not start, stop or rebuild services. A new app build is frozen at execution;
worker/PID/source/image changes also require a fresh transport binding.

This Windows/WSL fixture has separate loopback namespaces. A dedicated private
relay connects the Linux executor's callback URL to the verified Windows app;
its source, process start identities, exact sockets and authenticated capability
response are independently verified and frozen before each preparation. This is
test transport, not a product authority bypass. Both ordinary admission and Vault
release still reach their original authenticated product endpoints.

## Verification status

Eleven pure protocol tests cover the positive wait and negative source, scope, epoch,
configuration, premature-execution and duplicate paths. A new inert manifest has
passed filesystem validation. Protocol 2 has **not** run actual model preparation
or produced three consent-ready workspaces yet. Protocol 1's failed
artifact remains separate and unchanged.
