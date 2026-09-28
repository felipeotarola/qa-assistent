import { closeIdleBrowsers, disconnectBrowsers } from "../utils/browser";

export default defineNitroPlugin((nitro) => {
  const timer = setInterval(() => { void closeIdleBrowsers().catch(() => {}); }, 60000);
  timer.unref();
  nitro.hooks.hook("close", async () => { clearInterval(timer); await disconnectBrowsers(); });
});
