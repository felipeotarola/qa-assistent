# Personal Agent Template

Durable personal AI assistant built with Eve and Nuxt.

## Quick Reference

| Command | Description |
|---------|-------------|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Generate Nuxt types, then start Nuxt + Eve |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint (`pnpm lint:fix` to autofix) |
| `pnpm typecheck` | TypeScript check — app/server/shared plus `agent/` |
| `pnpm build:agent` | Build the Eve agent on its own |
| `pnpm auth:schema` | Regenerate the Better Auth Drizzle schema |
| `pnpm db:generate` | Regenerate the auth schema, then the Drizzle migration |
| `pnpm db:migrate` | Apply migrations |

## Structure

```
personal-agent-template/
├── agent/          # Eve agent (channels, tools, skills, connections)
├── app/            # Nuxt UI (pages, components, composables)
├── server/         # Nitro API, Drizzle schema, server utils
├── shared/         # Cross-layer types and helpers
└── docs/           # Architecture, environment, customization
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — System design, request flows, internal API
- [Environment](docs/ENVIRONMENT.md) — Environment variables
- [Customization](docs/CUSTOMIZATION.md) — Rename agent, add tools, integrations
- [Design system](docs/DESIGN_SYSTEM.md) — Shared UI components, theme, and layout conventions
- [README](README.md) — Quick start and feature overview

## UI and Layout Conventions

Read [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) before adding or changing UI.

- Use the existing **Nuxt UI 4 + Tailwind CSS 4 + Lucide** stack. Do not introduce a second component library or hand-build standard controls already supplied by Nuxt UI.
- Reuse `USelect` for value selection, `USelectMenu` for searchable selection, and `UDropdownMenu` for action menus. These have different semantics; use the appropriate shared primitive instead of a page-specific dropdown implementation.
- Put shared Nuxt UI styling/defaults in `app/app.config.ts`, and theme tokens/global styles in `app/assets/css/main.css`. Use semantic colors (`bg-default`, `text-muted`, `border-default`) so light/dark modes remain consistent.
- Reuse `app/layouts/default.vue`, `AppNavbar`, `WorkspaceCard`, and the settings layout/components. Pages compose these pieces; they must not independently recreate the application shell, split panes, card expansion, or settings sections.
- Before creating a component, search `app/components/`. Extract repeated product patterns into shared components; do not add pass-through wrappers around every Nuxt UI primitive. Keep business logic in feature components/composables.
- Local classes may control placement, width, and intentional density. Shared control styling belongs in the theme or a named reusable variant, not copied `:ui` overrides across pages.
- Preserve labels, keyboard navigation, focus handling, responsive layouts, and reduced-motion support. Verify changed shared components at their affected call sites in light/dark mode and narrow/wide layouts.

## Eve Framework

This project uses Eve with a Nuxt frontend (`eve/nuxt` module). Before writing agent code, read the relevant guide in `node_modules/eve/docs/` — start with `docs/README.md`, which maps each task to its page.

`nuxt typecheck` does not cover `agent/`, and `eve build` bundles without typechecking. `pnpm typecheck` runs both halves; keep it that way when adding agent code.

## Internal API Pattern

The Eve agent calls Nuxt over HTTP:

```
agent/lib/*-internal.ts  →  /api/internal/*  →  server/utils/*
```

Authenticated with `Authorization: Bearer <INTERNAL_API_SECRET>`. See [`server/utils/internal-api.ts`](server/utils/internal-api.ts).

## Memory

The caller's account identity — name, timezone, locale, bio — is injected into
the session instructions by [`agent/instructions.ts`](agent/instructions.ts),
read over the internal API. That is app data the Profile page owns, distinct
from the memory slot below, which holds what the agent chooses to remember.

Eve's `fileMemory()` provider, bound in [`agent/memory/profile.ts`](agent/memory/profile.ts)
and scoped per principal. Documents live in private Vercel Blob storage; the
agent maintains them with `profile__save_memory` and `profile__remove_memory`.

## Customization Checklist

- [`shared/agent.ts`](shared/agent.ts) — branding
- [`agent/instructions.ts`](agent/instructions.ts) — persona
- [`agent/channels/slack.ts`](agent/channels/slack.ts) — Slack Connect slug
- [`agent/agent.ts`](agent/agent.ts) — AI model

See [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md) for details.
