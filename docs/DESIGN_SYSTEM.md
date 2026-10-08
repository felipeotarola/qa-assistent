# Design system and shared UI

This is the UI convention for this project. The aim is to make a shared design
change in one place and have it apply consistently across chats, workspaces,
settings, and future mini apps.

## Existing stack

- Nuxt 4 and Vue 3 for the application.
- Nuxt UI 4 (`@nuxt/ui`) for UI primitives and dashboard components.
- Tailwind CSS 4 for layout and utility classes.
- Lucide (`i-lucide-*`) for interface icons. Simple Icons are available for brand logos.
- Inter and Geist Mono for typography, configured through Nuxt Fonts and the global stylesheet.

Continue using this stack. Do not add another UI kit or copy components from a
React/shadcn library into this Vue app. Use the installed Nuxt UI types and
implementation when checking supported props, slots, and theme options.

## Where changes belong

| Concern | Source of truth |
| --- | --- |
| Nuxt UI component defaults, shared slots and variants | `app/app.config.ts`, under `ui` |
| QAA semantic colors, spacing, radii, shadows and light/dark tokens | `app/assets/css/qaa-tokens.css` |
| Nuxt token bridge, fonts and global styles | `app/assets/css/main.css` |
| Shared QAA control/panel appearance, attached through Nuxt UI slots | `app/assets/css/qaa-primitives.css` |
| Sidebar, chat/workspace split and application shell | `app/layouts/default.vue` |
| Shared application header and account controls | `app/components/AppNavbar.vue`, `UserMenu.vue` |
| Workspace card preview, expansion and collapse | `app/components/WorkspaceCard.vue` |
| Workspace collection heading, description, divider and actions | `app/components/WorkspacePageHeader.vue` |
| Workspace content rendering and editing | `app/components/WorkspaceItemCard.vue` |
| Settings sections, rows and navigation | `app/components/settings/`, composed by `app/pages/settings/` |
| Feature state and reusable behavior | `app/composables/` |

Nuxt UI primitives are already shared components: use them directly. Add a
product component when it provides shared behavior, composition, or a meaningful
product-level API. Avoid wrappers whose only purpose is forwarding every prop.

## Component selection

| Need | Use |
| --- | --- |
| Choose one value, such as workspace, reasoning or version | `USelect` |
| Search/filter a longer list of values | `USelectMenu` |
| Menu of actions, such as account/settings/sign out | `UDropdownMenu` |
| Buttons and icon buttons | `UButton`; label icon-only actions with `aria-label` |
| Text entry | `UInput`, `UTextarea`, with `UFormField` where appropriate |
| Dialogs, popovers and tooltips | `UModal`, `UPopover`, `UTooltip` |
| Standard read-only data tables | `UTable` |
| Expandable workspace object, including future mini apps | `WorkspaceCard` with slots |
| Settings section and row | `SettingsSection`, `SettingsRow` |

A value selector and an action menu need different keyboard behavior and roles.
Consistency means choosing the correct Nuxt UI primitive and its shared theme,
not forcing every popup into a single custom dropdown.

Current examples: `chat/ReasoningSelect.vue` and `WorkspaceSwitcher.vue` use
`USelect`; `profile/PhoneInput.vue` uses `USelectMenu`; `UserMenu.vue` uses
`UDropdownMenu`.

## Styling and layout rules

Page content uses the available width (`--ui-container: 100%`). Settings sections
use `.app-page` and `--app-page-padding`; do not reintroduce centered page max-widths.
Inputs, small preview cards and authentication forms may retain their own widths.
Dialogs share `--app-dialog-width` through the global Nuxt UI modal theme, with
viewport gutters on small screens. Use the shared `qaa-modal-confirmation` content class for compact action confirmations (32rem); detail/editor dialogs retain the default width. Do not introduce one-off dialog widths.
Standard tables share their header and row styling through the Nuxt UI table theme.

Material has persistent card/table presentation and a common title/ID search.
The card collection uses a fluid CSS grid: columns start at 20rem (or the available
width on narrow panels) and share remaining space equally. Cards fill their grid
track; do not add fixed maximum widths to cards or embedded browser wrappers.
Both presentations open the same workspace object and use `MaterialId` for copy
feedback. `shared/workspace-presentation.ts` owns material labels and icons.
Long diagram summaries are expandable so the canvas remains the primary content.

1. Search for an existing component/pattern before adding markup. Reuse it, or
   extend its props/slots when the same behavior is needed elsewhere.
2. Make app-wide control changes in `app.config.ts`. Avoid per-page changes to
   dropdown shadows, borders, option spacing, focus styles, and typography.
3. Use semantic classes such as `bg-default`, `bg-muted`, `text-highlighted`,
   `text-muted`, `text-dimmed`, and `border-default`. Use semantic status colors
   for errors/success. Avoid new hardcoded light/dark color pairs in features.
4. Use the existing Tailwind spacing scale and Nuxt UI size/variant props.
   Local widths, flex/grid placement, and intentional compact controls are fine.
   Repeated layout combinations should become shared components.
5. Keep pages focused on composing components and supplying data. The default
   layout owns the sidebar, shared header and resizable chat/workspace panes.
   New workspace tools use the existing card shell and expansion behavior.
6. Keep special interactions local to their shared feature component. The
   editable table grid and browser viewport are examples where custom markup
   can be justified. A custom grid is not a template for hand-building every
   input, menu or table elsewhere.

These rules apply to new work and to components being changed. Existing native
inputs in the workspace editor are not yet fully standardized. When touching
them, prefer Nuxt UI controls where they fit, preserving grid keyboard behavior
and density. This document does not claim a complete UI migration has happened.

## Workspace views

The workspace header groups actions in the `Verktyg` dropdown using
`UDropdownMenu`: creation/upload actions follow the selected view, while
connections and trash are always available. The existing view tabs remain
navigation. `WorkspaceDestinations` is a controlled dialog opened from this
menu; the upload input stays mounted outside the menu portal.

Vault is a permanent workspace-header and sidebar action. `WorkspaceVault` is
mounted once by the shell; job cards and Otto's chat report open this same dialog.
It accepts repository-scoped variables before a setup plan exists. Saved values
never return to the client; drafts stay local and are cleared on close or workspace
change. Saving keys does not execute code. Continuing requires a verified setup
plan and an explicit user action that grants only its listed variables.

When a workspace has a Linear destination, its Linear tab reads the selected
project through an authenticated, project/team-scoped endpoint. Overview,
paginated issues and project documents remain provider data, not duplicated
Material objects. Refresh is explicit and the fetch time is visible. Issue
actions dispatch to the current workspace chat (or create one): test planning
stores a source-linked test plan; reporting requests an evidence-backed Linear
comment through the existing external tool. These actions never silently change
issue status. Browsing is read-only and credentials stay server-side.

The shared sidebar groups global navigation, workspace selection/tools, and chats
with `SidebarNavigationGroup` (Nuxt UI Collapsible). Group choices survive route
changes and mobile drawer remounts. Workspace shortcuts select the existing
Overview / Testing / Material views; no separate copies of these pages exist.
The header and settings footer stay fixed while navigation scrolls. Active links
use the shared sidebar styling, including chat rows and their activity spinners.

`WorkspacePanel` owns the Overview / Testing / Material navigation. The selected
view is addressable through `workspaceView=testing|material`; absence means
Overview. `WorkspaceOverview` links to the same existing items, not copies.
Test plans appear under Testing; other saved items appear under Material.
The browser remains mounted across view changes, but its inline card is shown
only in Material. Testing lists test plans, never standalone material or browser cards. Card controls and creation actions stay in their relevant view.
An active browser has a live preview in Pågående arbete across workspace views.
Opening it reveals the existing browser card in Material. The Testing tab indicates an active agent turn with a browser
session, not merely an idle open browser, and stops during human takeover.
Plan readiness describes the definition only, never a test execution outcome.

`WorkspaceQuality` appears in Overview and Testing and uses the same persisted
test runs and workspace quality settings. The selected environment, URL and
release/commit scope the counts; older or unscoped results are shown as needing
a retest, never carried forward as release evidence. Empty selections are
explicitly historical, not a release approval. Result details link to the
existing evidence and plan history.

Test readiness is a separate, editable set of observed prerequisites. Checks
can apply to all cases or selected cases; unknown is distinct from blocked.
Changing the target resets checks to unknown. Notes must not contain credentials.
Regression selection stores existing case IDs, not copied plans. Comparisons
require matching case definitions and environments and documented versions.
Actions dispatch to the workspace chat: verify prerequisites, run a bounded
selection, suggest follow-ups, retest, or prepare a defect draft in Material.
Preparing a draft never publishes to Linear or changes an issue's status.

## Accessibility and verification

Preserve keyboard navigation, visible focus, accessible names, Escape behavior,
and sensible focus return after closing overlays. Follow reduced-motion settings.
Use the library's overlay behavior rather than recreating focus traps or menus.

When changing a shared component or theme, inspect its call sites and verify the
affected contexts: light/dark theme, narrow/wide layout, empty and populated
content, and disabled/loading/error states when applicable. Run lint and
typecheck for code changes. Documentation-only changes need link/path checks.

New exceptions should have a concrete interaction requirement documented near
the implementation. Routine decisions following these conventions do not need
additional user approval.

## Visual identity

The current visual reference is [OpenAI Apps SDK UI](https://openai.github.io/apps-sdk-ui/),
particularly its neutral gray palette, semantic surfaces, rounded controls and
restrained elevation. This is a Vue adaptation, not the React package or a copy
of ChatGPT's application shell. Existing `qaa-*` names remain compatibility aliases.
Keep palette literals exclusively in `qaa-tokens.css`.

Import order is Tailwind, Nuxt UI, tokens, primitives, then the Nuxt semantic
bridge in `main.css`. Shared slot classes preserve Nuxt/Reka keyboard, focus,
popup and field behavior. Standard actions are 40px (44px on mobile), metadata
is 12px, body text is 15px and navigation icons are 20px. Compact controls can
use Nuxt UI size props. Controls have 12px corners, panels 16px, and the chat
composer 24px. Status colors remain independently readable in both themes.

Use plain neutral page surfaces, subtle borders and elevation for overlays.
Navigation uses a filled active surface without an extra outline. Do not bring
back decorative page gradients or compensate for the browser's zoom with global
CSS scaling. Verify at normal zoom as well as narrow viewport widths.

The existing resizable split, Nuxt sidebar drawer breakpoint (1024px), full-width
pages and shared 80rem detail dialogs remain the application layout contract.
No test behavior, saved objects or agent integrations change with the theme.

## Global agent guide

`/agents` is accessible through Globalt → Agenten, independently of the selected
workspace. `shared/agent-capabilities.ts` describes implemented capabilities,
prerequisites, result locations and related capabilities. Update this catalog when
tool behavior changes; it is product guidance, not runtime health or permissions.
The page uses `useConnectors()` for account-specific Linear/GitHub status and links
to the existing integration settings. It never starts a test or publishes an issue
when selecting a capability or copying an example. The guide distinguishes the
main agent from the implemented Eve repo specialist, explaining delegation and
the separate VPS code runner. Only show implemented agent roles; do not invent
running-task counts, browser availability or workspace destination readiness here.

`AgentTeamMap.client.vue` renders the guide with the existing Vue Flow dependency.
Nodes select the shared capability content in an adjacent detail panel (stacked on
narrow screens). Animated edges illustrate relationships only, with an explicit
pause control and automatic reduced-motion support. Keep node buttons and the
Nuxt UI selector keyboard accessible; do not turn illustrative motion into fake
runtime status. No agent is started by interacting with the map.

## Agent activity

Completion summaries appear above the composer in `ChatWorkReport`, including on
the home page. They project persisted worker status from the existing activity
feeds; they do not submit a chat message, run a model, restart a job or add a
second polling loop. A summary names its workspace scope and distinguishes a
finished worker from passing tests. Details remain in Pågående arbete. The
optional review button fills the current draft and preserves its contents;
Iris review is available only in the source chat, and Codex opens its existing
details because its status tool is sandbox-scoped. Dismissal lasts for the app
session; saved reports remain available after reload. No closed-workspace
monitoring or guaranteed push delivery is implied.

`shared/work-report.ts` classifies structured repository failure phases as setup,
execution, interruption or unknown. Exit code alone never establishes a product
defect. Unknown states never produce a completion summary. Incoming workspace
responses must match the selected workspace before populating the summary.
Reasoning uses `ChatReasoningDetails`, collapsed by default even while streaming;
users may expand it explicitly. Normal agent reports lead with the result,
material blockers and one recommended next step, with detailed evidence saved
separately. Follow-up choices should normally be limited to one to three.

Follow-up buttons use the existing `ChatSuggestions` component. They appear below
the final assistant message after a successful turn and fill the composer without
submitting it or replacing the user's existing draft. `latestChatSuggestions`
reads the latest suggestion output across the current user turn, including when
the tool result and final answer are separate messages. A new user turn, error,
incomplete output or explicit empty suggestion list hides older choices. Do not
invent generic fallback actions when the agent has not supplied suggestions.

`AgentActivityPanel` is mounted once in the default layout. It follows the open
chat across workspace tabs and can be closed without cancelling work.
The pin action docks it as a separate right-hand column in the shared layout
at viewport widths of 1280px and above. The preference is stored in a cookie;
narrower screens use the drawer without clearing that preference. Docked content
has its own scroll area and never overlays the workspace. `AgentActivitySurface`
owns the dock/drawer presentation while the panel retains its feature state.
It opens
on a new busy transition, not on every tool event. `shared/agent-activity.ts`
projects the latest user task from durable chat messages with stable tool-call
IDs. No separate result store, guessed plan, progress percentage or fictional
workers are introduced. The actor/parent identity fields form the extension
boundary for orchestration. `AgentWorkerActivity` follows real child-session
streams discovered through `subagent.called`, with at most eight subscriptions.
Replayed calls deduplicate by child ID, and a new parent turn clears old workers.
Child reasoning and raw tool payloads are not rendered; their internal messages
must not become user turns in the main conversation.
Switching chats clears the previous projection; reopening a chat rebuilds it.
This is not a monitor of unopened chats or background child sessions.

Tool success is separate from test success. Incomplete calls are unconfirmed,
not green. The panel does not render raw tool payloads or reasoning. Analysis events show status only. Tool steps expand into the same bounded, display-field projection used in chat (command, output, exit code and task fields); credential-shaped values are redacted. Workspace
write receipts link to existing objects; selected assistant text is explicitly
saved as a new material note with source-chat evidence. The authenticated
activity-material endpoint uses a transactional source receipt to deduplicate
retries, including after reload. Deleted notes must be restored from trash.

## Material diagrams

Repository maps reuse this diagram surface. Optional `repository` metadata pins
the GitHub URL and full commit; node `code` references use relative paths and
optional line numbers. Links are generated for that commit. Component selection
works through node buttons or the Nuxt UI selector and dims unrelated nodes.
Details and “Föreslå tester” appear below the canvas, including on narrow screens.
The action dispatches a proposal to the existing scoped chat; it does not run tests.
Code evidence is explicitly distinct from functional verification. Old website
diagrams retain their existing schema and legends.

Material supports a versioned `diagram` object rendered with Vue Flow and Dagre automatic layout. The canvas provides pan, zoom and fit controls; node positions are generated, not manually saved. Standard controls remain Nuxt UI. Nodes and relationships can be edited through the normal workspace editor or its agent quick task.

Use solid relationships for verified links and dashed relationships for inferred structure. Verified edges require an evidence description; a URL list alone is not evidence of navigation. Diagrams retain source item IDs and exact versions and expose those snapshots through the shared source viewer. Limit each diagram to 150 nodes and 400 relationships; prefer focused maps for readability.

## Repository execution cards

`useExecutionFeed` owns the workspace's shared SSE subscription and four-second
fallback refresh (backoff up to 30 seconds on errors). `RepositoryRuns` consumes
this state and bounded history;
it appears inside AgentActivityPanel with sandbox and browser activity.
There is no separate floating execution host. The shared panel is available
without an active chat when the workspace has executions.
`RepositoryRunCard` renders actual VPS job state, logs and cancellation across
workspace views. Completed jobs can be saved to Material through the authenticated
repository-material endpoint, which builds content from the persisted run and
uses a durable receipt to deduplicate retries. Do not restore the old repository
connection form under Testing. Request a repo URL and execution in chat.

`SandboxRuns` shares the activity panel and shows real sandbox status, observed
process output and stop controls. A completed shell command does not mean a
background app it started has exited. `BrowserWorkspace` selects explicit
sessions, including child-agent previews; takeover and return target that ID.
All controls keep their Nuxt UI styles and keyboard labels. No percentages or
worker counts are invented from model narration.

The activity panel groups live VPS work above the chat timeline. Completed
processes and older tool steps are collapsed by default, with explicit history
controls. Opening/closing the panel never cancels execution; stop buttons are
explicit. Live browser previews open the existing workspace browser controls.
# Project environment configuration

`ProjectEnvironment` lives in the shared **Pågående arbete** panel. It uses Nuxt UI
modal, labeled password inputs and buttons, displays repo/commit/command context,
and separates save-only from explicit save-and-continue. Existing values are never
loaded into inputs; only configured names are returned. Import reads a local file
as literal data, includes only requested keys and never submits automatically.
Required and optional variables include their purpose. Forms clear on close and
workspace change. Keep live browser controls in the same panel; a running app
server alone must not label a completed agent job as active.
