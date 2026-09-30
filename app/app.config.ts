export default defineAppConfig({
  site: {
    name: "V",
    title: "V",
    description:
      "Your personal AI agent. Chat on the web, Slack, or iMessage — query Linear and pick up where you left off.",
    tagline: "Vercel × Eve",
    author: "Hugo Richard",
    repo: "https://github.com/vercel-labs/personal-agent-template",
    deployUrl:
      "https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fpersonal-agent-template&env=BETTER_AUTH_SECRET,BETTER_AUTH_URL,INTERNAL_API_SECRET&envDescription=BETTER_AUTH_SECRET%3A%20run%20openssl%20rand%20-base64%2032%20%7C%20BETTER_AUTH_URL%3A%20your%20production%20URL%20%7C%20INTERNAL_API_SECRET%3A%20shared%20secret%20for%20web%20%2B%20eve&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fpersonal-agent-template%2Fblob%2Fmain%2Fdocs%2FENVIRONMENT.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22tursocloud%22%2C%22productSlug%22%3A%22database%22%2C%22protocol%22%3A%22storage%22%7D%5D&project-name=personal-agent&repository-name=personal-agent",
    ogImage: "/og.png",
    twitter: "@hugorcd",
  },
  ui: {
    modal: {
      slots: { content: 'qaa-modal', body: 'p-5 sm:p-6', title: 'text-lg font-semibold tracking-tight', header: 'bg-default' },
      variants: { overlay: { true: { overlay: 'bg-[var(--qaa-overlay)]' } }, fullscreen: { false: { content: 'w-[calc(100vw-2rem)] max-w-[var(--app-dialog-width)] rounded-2xl' } } },
    },
    table: { slots: { th: 'bg-muted text-xs font-semibold text-muted py-3', td: 'py-4 border-b border-default text-sm', tr: 'hover:bg-muted/50' } },
    input: { slots: { base: 'qaa-field' }, variants: { variant: { outline: 'qaa-field-outline' }, size: { md: { base: 'qaa-field-standard py-2 text-sm' }, lg: { base: 'qaa-field-standard' } } } },
    textarea: { slots: { base: 'qaa-field' }, variants: { variant: { outline: 'qaa-field-outline' } } },
    select: { slots: { base: 'qaa-field', content: 'qaa-popup' }, variants: { variant: { outline: 'qaa-field-outline' }, size: { md: { base: 'qaa-field-standard py-2 text-sm' } } } },
    selectMenu: { slots: { base: 'qaa-field', content: 'qaa-popup' }, variants: { variant: { outline: 'qaa-field-outline' }, size: { md: { base: 'qaa-field-standard py-2 text-sm' } } } },
    dropdownMenu: { slots: { content: 'qaa-popup', item: 'rounded-lg py-2' } },
    popover: { slots: { content: 'qaa-popup' } },
    card: { slots: { root: 'qaa-panel' } },
    chatPrompt: { slots: { root: 'qaa-composer p-4', base: 'text-base', footer: 'pt-2' } },
    dashboardSidebar: { slots: { root: 'qaa-sidebar', header: 'px-4', body: 'px-2 py-2 gap-1', footer: 'p-2', content: 'qaa-sidebar qaa-navigation-drawer', overlay: 'bg-[var(--qaa-overlay)]' } },
    navigationMenu: { slots: { link: 'min-h-11 rounded-xl text-[15px] font-normal', linkLeadingIcon: 'size-5 text-toned' } },
    badge: {
      slots: { base: 'qaa-badge' },
      compoundVariants: [
        { color: 'success', variant: ['soft', 'subtle'], class: 'qaa-badge-success' },
        { color: 'warning', variant: ['soft', 'subtle'], class: 'qaa-badge-warning' },
        { color: 'error', variant: ['soft', 'subtle'], class: 'qaa-badge-error' },
        { color: 'info', variant: ['soft', 'subtle'], class: 'qaa-badge-info' },
        { color: 'neutral', variant: ['soft', 'subtle'], class: 'qaa-badge-neutral' },
      ],
    },
    colors: {
      primary: "neutral",
      neutral: "neutral",
    },
    button: {
      slots: {
        base: "qaa-button",
      },
      variants: { size: { md: { base: 'qaa-button-standard px-3.5 py-2 text-sm gap-2', leadingIcon: 'size-5', trailingIcon: 'size-4' }, lg: { base: 'qaa-button-standard' } } },
      compoundVariants: [
        { square: true, size: 'xs', class: 'qaa-button-square qaa-button-square-xs' },
        { square: true, size: 'sm', class: 'qaa-button-square qaa-button-square-sm' },
        { square: true, size: 'md', class: 'qaa-button-square qaa-button-square-md' },
        { square: true, size: 'lg', class: 'qaa-button-square qaa-button-square-lg' },
        { square: true, size: 'xl', class: 'qaa-button-square qaa-button-square-xl' },
        { color: ['neutral', 'primary'], variant: 'solid', class: 'qaa-button-primary' },
        { color: ['neutral', 'primary'], variant: 'outline', class: 'qaa-button-outline' },
        { color: ['neutral', 'primary'], variant: ['soft', 'subtle'], class: 'qaa-button-secondary' },
        { color: ['neutral', 'primary'], variant: ['ghost', 'link'], class: 'qaa-button-quiet' },
      ],
      defaultVariants: {
        size: "md",
      },
    },
  },
});
