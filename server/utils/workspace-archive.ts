import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';

// Archiving organizes the owner's list. It neither cancels jobs nor revokes links.
// Existing direct chat links remain usable; ownership checks remain unchanged.
export async function setWorkspaceArchived(userId: string, id: string, archived: boolean) {
  return db.transaction(async tx => {
    const [workspace] = await tx.select().from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, userId))).for('update');
    if (!workspace) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
    if (archived && !workspace.archivedAt) {
      const [activity] = await tx.execute(sql`select (
        exists(select 1 from pat_missions where workspace_id = ${id} and
          (lifecycle is not null and lifecycle <> 'closed' or lifecycle is null and status = 'active'))
        or exists(select 1 from pat_mission_reports r join pat_missions m on m.id = r.mission_id where m.workspace_id = ${id} and r.status in ('queued', 'running'))
        or exists(select 1 from pat_mission_resource_claims where workspace_id = ${id})
        or exists(select 1 from pat_setup_jobs where workspace_id = ${id} and status not in ('completed', 'failed', 'cancelled'))
        or exists(select 1 from pat_browser_jobs j join pat_threads t on t.id = j.thread_id
          where t.workspace_id = ${id} and j.status not in ('completed', 'failed', 'cancelled'))
        or exists(select 1 from pat_repository_runs where workspace_id = ${id}
          and (job is null or coalesce(job->>'status', '') not in ('passed', 'failed', 'blocked', 'cancelled', 'review')))
      ) as busy`);
      if (activity?.busy) throw createError({ statusCode: 409, statusMessage: 'Workspacet har pågående eller obekräftat arbete. Avsluta det innan du arkiverar.' });
    }
    const [saved] = await tx.update(schema.workspaces).set({ archivedAt: archived ? workspace.archivedAt ?? new Date() : null })
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, userId))).returning();
    return { workspace: { id: saved!.id, name: saved!.name, archivedAt: saved!.archivedAt?.toISOString() ?? null } };
  });
}
