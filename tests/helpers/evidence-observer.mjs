import { observedReviewCalls } from './evidence-acceptance.mjs';
import { projectPreservedIris } from './evidence-preserved-iris.mjs';

/** No service imports: a transaction_read_only SQL connection is mandatory.
 * One repeatable-read snapshot avoids misclassifying a partial cross-table
 * observation during the scheduler's atomic commits. No lease/token/secrets. */
export async function observeEvidence(sql, workspaceId, runtime, { preservedIris = false } = {}) {
  return sql.begin('isolation level repeatable read read only', async tx => {
    const [missions, tasks, attempts, jobs, runs, reviews, reports, claims, events, captures, items, repositories, setups] = await Promise.all([
      tx`select id,thread_id,runtime,intent,lifecycle,phase,closure_reason,config,admission,plan_revision,mandate_revision,closed_at from pat_missions where workspace_id=${workspaceId} and runtime=${runtime} order by created_at,id`,
      tx`select t.id,t.mission_id,t.state,t.spec,t.sources,t.supplement_round,t.plan_revision from pat_mission_tasks t join pat_missions m on m.id=t.mission_id where m.workspace_id=${workspaceId} and m.runtime=${runtime} order by t.created_at,t.id`,
      tx`select a.id,a.mission_id,a.task_id,a.kind,a.status,a.attempt_no,a.supplement_round,a.executor_resource_id,a.usage,a.tool_calls,a.tool_call_ids,a.reserved_tokens,a.created_at,a.finished_at from pat_mission_attempts a join pat_missions m on m.id=a.mission_id where m.workspace_id=${workspaceId} and m.runtime=${runtime} order by a.created_at,a.id`,
      tx`select b.id,b.status,b.session_id from pat_browser_jobs b join pat_threads t on t.id=b.thread_id where t.workspace_id=${workspaceId} order by b.id`,
      tx`select id,item_id,case_id,plan_version,snapshot,target,runtime,result,started_at,finished_at,mission_attempt_id from pat_test_runs where workspace_id=${workspaceId} order by started_at,id`,
      tx`select id,run_id,status,assessment,input,input_hash,source_hash,reviewer_version,model,finished_at from pat_result_assessments where workspace_id=${workspaceId} and runtime=${runtime} order by created_at,id`,
      tx`select r.id,r.mission_id,r.status,r.item_id,r.document,r.usage,r.attempts,r.read_receipts,s.input from pat_mission_reports r join pat_missions m on m.id=r.mission_id join pat_mission_snapshots s on s.id=r.snapshot_id where m.workspace_id=${workspaceId} and m.runtime=${runtime} order by r.created_at,r.id`,
      tx`select id,mission_id,attempt_id,state,owner from pat_mission_resource_claims where workspace_id=${workspaceId} order by id`,
      tx`select e.id,e.mission_id,e.kind,e.payload,e.created_at from pat_mission_events e join pat_missions m on m.id=e.mission_id where m.workspace_id=${workspaceId} and m.runtime=${runtime} order by e.created_at,e.id`,
      tx`select c.id,c.run_id,c.item_id,c.url,c.error,i.version,i.content,i.provenance,i.deleted_at from pat_test_captures c join pat_test_runs r on r.id=c.run_id left join pat_workspace_items i on i.id=c.item_id where r.workspace_id=${workspaceId} order by c.id`,
      tx`select id,title,version,content,provenance,deleted_at from pat_workspace_items where workspace_id=${workspaceId} order by id`,
      tx`select id,runtime from pat_repository_runs where workspace_id=${workspaceId} order by id`,
      tx`select id,runtime,status from pat_setup_jobs where workspace_id=${workspaceId} order by id`,
    ]);
    const originals = preservedIris ? projectPreservedIris(await tx`select a.id,a.mission_id,a.kind,a.status,a.runtime,a.dispatch_id,a.executor_resource_id,a.created_at,a.finished_at,a.usage,a.tool_call_ids,m.workspace_id,m.user_id,m.thread_id,m.lifecycle,b.id as job_id,b.runtime as job_runtime,b.thread_id as job_thread_id,b.session_id,b.status as job_status,t.user_id as job_user_id,t.workspace_id as job_workspace_id from pat_mission_attempts a join pat_missions m on m.id=a.mission_id left join pat_browser_jobs b on b.id=a.dispatch_id left join pat_threads t on t.id=b.thread_id where m.workspace_id=${workspaceId} and m.runtime=${runtime} and a.kind='browser_tests' order by a.created_at,a.id limit 101`) : null;
    return { ...(originals ? { preservedIris: originals } : {}), missions, tasks, attempts: attempts.map(({ tool_call_ids, ...attempt }) => ({ ...attempt, reviewCalls: observedReviewCalls(tool_call_ids) })),
      jobs, runs, reviews, reports, claims, events, captures, items, repositories, setups };
  });
}
