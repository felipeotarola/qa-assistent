import { z } from "zod";

export const BROWSER_THREAD_HEADER = "x-pat-browser-thread";
export const browserActionSchema = z.object({
  action: z.enum(["open", "inspect", "click", "fill", "press", "select", "scroll", "back", "forward", "reload", "close"]),
  url: z.string().max(4096).optional(),
  ref: z.string().regex(/^[a-z0-9-]+$/).optional(),
  text: z.string().max(10000).optional(),
  direction: z.enum(["up", "down"]).optional(),
  runId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional().describe('Only when resuming an explicitly selected browser session in this workspace.'),
  expectedUrl: z.string().url().max(4096).optional().describe('Optional exact observed/known destination for click, press or inspect. Waits up to 5 seconds without repeating the action; unmet means unverified, not a proven product defect.'),
});
export type BrowserAction = z.infer<typeof browserActionSchema>;
export interface BrowserView {
  assignmentId?: string;
  threadId?: string;
  agentId?: string;
  preview?: boolean;
  sessionId: string;
  liveUrl: string;
  url: string;
  title: string;
  control: "agent" | "human";
  expiresAt: string;
}
