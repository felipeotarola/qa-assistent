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
viewport gutters on small screens. Do not override individual dialog widths.
Standard tables share their header and row styling through the Nuxt UI table theme.

Material has persistent card/table presentation and a common title/ID search.
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

`WorkspacePanel` owns the Overview / Testing / Material navigation. The selected
view is addressable through `workspaceView=testing|material`; absence means
Overview. `WorkspaceOverview` links to the same existing items, not copies.
Test plans appear under Testing; other saved items appear under Material.
The browser remains mounted across view changes and is available in both working
views. Card controls and creation actions stay in their relevant view.
An active browser also has a floating live preview across workspace views.
It can be minimized without closing the session; opening it reveals the existing
browser card. The Testing tab indicates an active agent turn with a browser
session, not merely an idle open browser, and stops during human takeover.
Plan readiness describes the definition only, never a test execution outcome.

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

## QAA visual identity

The visual reference is QAA Platform (`C:/Projects/qaa-platform/src/frontend/chatbot`)
and its live workspace at `https://qa.felipeotarola.com/workspace`. Semantic root
tokens are copied from its `theme.css`; shared control appearance and the page
header/metric strip patterns are adapted from `primitives.css` and
`design-system.css`. Keep palette literals exclusively in `qaa-tokens.css`.

Import order is Tailwind, Nuxt UI, QAA tokens, QAA primitives, then the Nuxt
semantic bridge in `main.css`. Named `qaa-*` slot classes implement shared
appearance without replacing Nuxt/Reka keyboard, focus, popup or field behavior.
Use the Nuxt UI size prop for intentional compact controls; standard actions are
40px (44px on mobile), metadata is 12px and controls/body text are 14px. Status
colors retain independent success, warning, error and info tokens in both modes.

Necessary framework/layout adaptations: this remains Vue/Nuxt UI and Vue Flow,
not React/shadcn/React Flow. The existing resizable split, Nuxt sidebar drawer
breakpoint (1024px), full-width pages and shared 80rem detail dialogs are retained.
QAA's 720px chat and 760px detail limits do not override those agreed layouts.
No test behavior, saved objects or agent integrations are changed by the theme.

## Material diagrams

Material supports a versioned `diagram` object rendered with Vue Flow and Dagre automatic layout. The canvas provides pan, zoom and fit controls; node positions are generated, not manually saved. Standard controls remain Nuxt UI. Nodes and relationships can be edited through the normal workspace editor or its agent quick task.

Use solid relationships for verified links and dashed relationships for inferred structure. Verified edges require an evidence description; a URL list alone is not evidence of navigation. Diagrams retain source item IDs and exact versions and expose those snapshots through the shared source viewer. Limit each diagram to 150 nodes and 400 relationships; prefer focused maps for readability.
