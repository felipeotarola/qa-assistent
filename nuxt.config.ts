import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const eveSharedDirectory = resolve(dirname(createRequire(import.meta.url).resolve("eve/client")), "../shared");
const privateNoStore = { "cache-control": "private, no-store" } as const;
const noStore = { "cache-control": "no-store" } as const;
const databaseUrl = process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || process.env.DATABASE_URL;
const supabasePooler = databaseUrl ? new URL(databaseUrl).hostname.endsWith(".pooler.supabase.com") : false;

export default defineNuxtConfig({
  modules: ["@nuxt/ui", "@nuxt/eslint", "@comark/nuxt", "eve/nuxt", "@nuxthub/core", "@vercel/analytics"],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: true },
  compatibilityDate: "latest",
  experimental: {
    payloadExtraction: true,
    viewTransition: true,
  },
  routeRules: {
    "/login": { prerender: true },
    "/": { ssr: true, headers: privateNoStore },
    "/chat/**": { ssr: true, headers: privateNoStore },
    "/settings/**": { ssr: true, headers: privateNoStore },
    "/api/auth/**": { headers: noStore },
    "/api/internal/**": { headers: noStore },
    "/api/profile": { headers: privateNoStore },
    "/api/profile/**": { headers: privateNoStore },
    "/api/threads": { headers: privateNoStore },
    "/api/threads/**": { headers: privateNoStore },
    "/api/workspaces/**": { headers: privateNoStore },
    "/api/workspaces": { headers: privateNoStore },
    "/api/memory": { headers: privateNoStore },
    "/api/memory/**": { headers: privateNoStore },
    "/api/connectors": { headers: privateNoStore },
    "/api/slack/**": { headers: privateNoStore },
    "/api/integrations/**": { headers: privateNoStore },
    "/eve/v1/**": { headers: noStore },
  },
  vite: {
    optimizeDeps: {
      // Client code imports `ai` for its UI part helpers. `ai` is already ESM,
      // so Vite would serve it unbundled — and its @ai-sdk/gateway dependency
      // imports @vercel/oidc, whose browser build is CommonJS and cannot
      // provide named exports to the browser. Pre-bundling `ai` converts the
      // whole chain to ESM.
      include: ["ai"],
    },
  },
  nitro: {
    // Eve's package-internal #shared imports must resolve inside Eve, not
    // against Nuxt's application #shared alias.
    externals: { external: ["eve/client"] },
    rollupConfig: {
      plugins: [{
        name: "eve-package-shared-imports",
        resolveId: {
          order: "pre",
          handler(source, importer) {
            // The prerender build inlines packages even when the production
            // server externalizes them. Respect Eve's package import scope.
            if (source.startsWith("#shared/") && importer?.replaceAll("\\", "/").includes("/eve/dist/src/")) return resolve(eveSharedDirectory, source.slice("#shared/".length));
            return null;
          },
        },
      }],
    },
    compressPublicAssets: true,
    prerender: {
      routes: ["/login"],
      crawlLinks: false,
    },
  },
  app: {
    head: {
      htmlAttrs: { lang: "en" },
      title: "V",
      titleTemplate: "%s",
      charset: "utf-8",
      viewport: "width=device-width, initial-scale=1",
      meta: [
        {
          name: "description",
          content:
            "Your personal AI agent. Chat on the web, Slack, or iMessage — query Linear and pick up where you left off.",
        },
        { name: "theme-color", content: "#1b1718" },
        { name: "color-scheme", content: "light dark" },
        { name: "robots", content: "index, follow" },
      ],
      link: [
        { rel: "icon", href: "/favicon.ico" },
      ],
    },
  },

  fonts: {
    families: [
      { name: 'Geist', weights: ['100 900'], global: true },
      { name: 'Geist Mono', weights: ['100 900'], global: true },
    ],
  },

  hub: {
    // Pin PostgreSQL: pglite's WASM payload cannot survive Eve's bundling.
    // The migration script validates DATABASE_URL before starting or building.
    db: {
      dialect: "postgresql",
      driver: "postgres-js",
      // Local development and serverless instances share a small Supabase pool.
      connection: { max: 2, idle_timeout: 10, connect_timeout: 15, prepare: false, ...(supabasePooler ? { port: 6543 } : {}) },
      // Use our prefixed migration ledger in the shared Supabase database.
      applyMigrationsDuringDev: false,
      applyMigrationsDuringBuild: false,
    },
  },
  runtimeConfig: {
    public: {
      supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "",
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL || "",
    },
  },
});
