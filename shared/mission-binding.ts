import { z } from 'zod';
import { toolJson } from './tool-json.ts';
export const missionBindingSchema = toolJson(z.object({ missionId: z.string().uuid(), taskId: z.string().uuid() }), 1000);
export type MissionBinding = z.infer<typeof missionBindingSchema>;
