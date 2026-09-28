# Local QA flow verification — 2026-09-28

Tested the authenticated localhost application through its UI using GLM 5.3 Flash / Low reasoning. Linear was read only. Public browser inspection did not submit login credentials or forms.

## Verified

- Workspace overview displays three workspaces. The grunden.ai homepage displays all six chats after creating two clearly named verification chats.
- Agent read the Linear project **Grunden Login Krav**. Its summary matches the description inspected independently in Linear.
- Agent created **QA-verifiering – Linear till testplan** with a source link and three structured test cases, initially marked Ej testat.
- The card's quick-task input added a Kommentar column and retained the existing rows and statuses (version 2).
- Browser inspection reached the public login modal, inspected the password input and captured a screenshot. The agent embedded it in the same document and recorded QA-003 as Delvis testat, explicitly excluding password logging from the verified scope (version 3).
- Both rendered image instances loaded at 1280 × 900. The card displays its image thumbnail and source count.
- Reload preserved chat messages and the document. Read-only database assertions confirmed three rows, one image reference, versions 1–3 and 75 persisted events for the first verification chat.
- A second chat read the saved document and correctly reported its version, statuses, image and Linear source without modifying it.
- Expanded document view and history selector exposed versions 1–3.
- The test document was moved to the recoverable trash and restored through the UI, retaining version 3 and its contents.

## Fix made during verification

Chat navigation started a manual View Transition inside Nuxt's own transition. Runtime logs showed unhandled AbortError and timeout errors. Removed the duplicate transition wrapper in `app/composables/chat/navigation.ts`; Nuxt now owns the animation. Retested chat → home → saved chat navigation without new transition errors. ESLint for the changed file and the complete app/agent typecheck passed.

## Remaining coverage and observations

- This run did not test writing tickets/comments to Linear, GitHub operations, production, authenticated remote-browser takeover, card dragging or image drag-and-drop.
- The model emitted a provider warning that `gateway.exa_search` is unsupported by the selected Grunden model. Direct browser inspection worked; general web search was not validated.
- The generated document retained its original disclaimer that no environment had been verified, even after the later browser check. The test row correctly records the partial result, but agents should reconcile summary-level disclaimers when updating reports.
- Test artefacts were retained for review: two verification chats, one document and its screenshot in grunden.ai.

First chat: `fc757ddc-9eef-46c4-9fb9-fa12cda6841d`.

Cross-chat verification: `05244f59-e26a-4483-b183-5ddd95de4ea8`.

Document: `3fdd7535-5686-4feb-914c-19b5b3911cd6`.

## Follow-up fixes and verification

- Replaced the provider-managed `web_search` with an authored function tool that searches Bing through the existing isolated Browserbase research endpoint. It requires no new search API credentials, consumes Browserbase usage, preserves workspace ownership checks and does not touch the live browser session. Search pages remain untrusted and blocking/challenge pages must be reported honestly.
- Added report-consistency instructions: update summaries, conclusions and verification scope when test observations change, preserving unrelated data and explicit user editing boundaries.
- Live regression with GLM 5.3 Flash: search for `Nuxt official documentation` returned a Bing result page, followed by successful research of the official Nuxt documentation.
- The same regression corrected the saved test document to version 4. Database assertions verified removal of the obsolete blanket disclaimer and exact preservation of the version-3 table and image blocks.
- No new unsupported Exa warning appeared in the test. Agent build, app/agent typecheck and lint of the new tool passed.
