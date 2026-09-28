# Chat recovery

The prompt shows a shared Nuxt UI alert for transport/history/turn errors.
Reload fetches the current runtime binding and replays history; it never calls
send again. Uncertain outgoing text stays in sessionStorage under the thread ID
until confirmed completion or explicit user dismissal/restoration. Draft text
also survives reload in that tab. Storage failure retains the in-memory copy.
A restored outgoing message is an editable draft, never automatically submitted.
Users should check history and external operation receipts before resubmitting.
This prevents automatic replay, not every possible duplicate from a new manual request.

Checks:
- node --test tests/chat-recovery.test.mjs: dropped acknowledgement, no resend,
  double submit, successful cleanup and visible cancel/response errors.
- external-providers + external-receipts: provider scope and uncertain writes.
- workspace.integration: shared objects, versions, image references, private files.
- external.integration: user isolation, destinations and receipts.
- chat-history.integration: persisted history and context across runtime bindings.

Remaining acceptance run (real user grant): inspect a website, save its description
with screenshot, create a designated test Linear issue, and continue the same chat
in production. Run only after the corresponding code/environment is deployed.
No real external ticket was created by the recovery tests.
