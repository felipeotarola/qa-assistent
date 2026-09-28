import { z } from "zod";
export const researchSchema = z.object({ url: z.string().url().max(4096), screenshot: z.boolean().default(false) });
