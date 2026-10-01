import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { sandboxScope } from '../../utils/sandbox-scope';
import { repositoryRunner } from '../../utils/repositories';
import { db, schema } from '@nuxthub/db';
import { eq } from 'drizzle-orm';
import { runtimeScope } from '../../../shared/runtime-scope';
import { resolveChatModel, resolveReasoning } from '../../../shared/chat-models';
import { receiveSetupResult } from '../../utils/setup-jobs';
import { repositoryMapTarget } from '../../../shared/repository-map';

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = z.object({
    userId: z.string().uuid(), threadId: z.string().uuid(), sessionKey: z.string().min(1).max(300),
    action: z.enum(['start', 'status', 'cancel']), jobId: z.string().uuid(), task: z.string().min(1).max(12000).optional(),
    parentSessionId: z.string().optional(), model: z.string().optional(), reasoning: z.string().optional(),
  }).parse(await readBody(event));
  const thread = await getThreadForUser(body.userId, body.threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  // Axel's child session may finish before the worker; notify the durable chat.
  if (body.action === 'start' && body.task && repositoryMapTarget(body.task)) body.parentSessionId = thread.sessionId || body.parentSessionId;
  if (body.action==='start') {
    if (!body.parentSessionId || !body.task) throw createError({statusCode:400,statusMessage:'Parent session and task required'});
    await db.insert(schema.setupJobs).values({id:body.jobId,workspaceId:thread.workspaceId,threadId:body.threadId,runtime:runtimeScope(),parentSessionId:body.parentSessionId,sessionKey:body.sessionKey,task:body.task,model:resolveChatModel(body.model),reasoning:resolveReasoning(body.reasoning)}).onConflictDoNothing();
    const [saved] = await db.select().from(schema.setupJobs).where(eq(schema.setupJobs.id,body.jobId));
    if (!saved || saved.threadId!==body.threadId || saved.task!==body.task || saved.sessionKey!==body.sessionKey || saved.parentSessionId!==body.parentSessionId) throw createError({statusCode:409,statusMessage:'Setup submission conflict'});
  }
  const scope = sandboxScope(body.userId, body.threadId, body.sessionKey);
  let result;
  try {
    result = await repositoryRunner('/codex', { ...body, ...scope, workspaceId: thread.workspaceId });
  } catch (error) {
    // A confirmed rejection is not ongoing work. Transport-ambiguous submissions
    // stay available for status reconciliation and are never automatically replayed.
    const code = (error as {statusCode?:number}).statusCode;
    if (body.action==='start' && (code===400 || code===503)) {
      await db.update(schema.setupJobs).set({status:'failed',notification:'not_needed',result:{jobId:body.jobId,id:scope.id,workspaceId:thread.workspaceId,status:'failed',message:'Startbegäran avvisades. Se verktygssvaret för orsaken.',updatedAt:new Date().toISOString()}}).where(eq(schema.setupJobs.id,body.jobId));
    }
    throw error;
  }
  const [registered]=await db.select().from(schema.setupJobs).where(eq(schema.setupJobs.id,body.jobId));
  if (registered) await receiveSetupResult(result);
  return result;
});
