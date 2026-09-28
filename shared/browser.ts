import { z } from "zod";

export const BROWSER_THREAD_HEADER = "x-pat-browser-thread";
export const browserActionSchema = z.object({
  action: z.enum(["open", "inspect", "click", "fill", "press", "select", "scroll", "back", "forward", "reload", "close"]),
  url: z.string().max(4096).optional(),
  ref: z.string().regex(/^[a-z0-9-]+$/).optional(),
  text: z.string().max(10000).optional(),
  direction: z.enum(["up", "down"]).optional(),
});
export type BrowserAction = z.infer<typeof browserActionSchema>;
export interface BrowserView {
  sessionId: string;
  liveUrl: string;
  url: string;
  title: string;
  control: "agent" | "human";
  expiresAt: string;
}
