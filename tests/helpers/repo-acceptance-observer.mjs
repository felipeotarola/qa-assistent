// Parameterized read-only SQL only. Deliberately never selects sealed_values,
// auth credentials, toolCallIds, process argv or private executor bearer keys.
export async function observeRepoMission(sql, workspaceId, runtime, since) {
  return sql.begin('isolation level repeatable read read only', async tx => {
    const missions = await tx`select id,runtime,status,lifecycle,phase,closure_reason,config,deadline_at,report_deadline_at,lease_until,closed_at from pat_missions where workspace_id=${workspaceId} and runtime=${runtime} and created_at>=${since} limit 20`;
    // A sentinel preserves the actual schema query path for --audit even when
    // no task exists. It cannot refer to a UUID-backed mission.
    const ids = missions.length ? missions.map(m => m.id) : ['repo-acceptance-no-mission'];
    const [tasks, attempts, jobs, runs, reviews, reports, claims, events, captures, browsers, repositories, setups, waits, reportItems] = await Promise.all([
      tx`select id,state,blocked_reason,spec,sources,results from pat_mission_tasks where mission_id in ${tx(ids)} order by created_at limit 250`,
      tx`select id,task_id,kind,status,dispatch_id,operation_id,attempt_no,executor_resource_id,error,usage,tool_calls,reserved_tokens,created_at,finished_at,lease_until,deadline_at from pat_mission_attempts where mission_id in ${tx(ids)} order by created_at limit 250`,
      tx`select b.id,b.status,b.session_id,b.dispatch_lease_until,b.report from pat_browser_jobs b join pat_mission_attempts a on a.dispatch_id=b.id where a.mission_id in ${tx(ids)}`,
      tx`select r.id,r.item_id,r.case_id,r.plan_version,r.snapshot,r.target,r.runtime,r.result,r.started_at,r.finished_at,r.mission_attempt_id from pat_test_runs r join pat_mission_attempts a on a.id=r.mission_attempt_id where a.mission_id in ${tx(ids)} limit 100`,
      tx`select v.id,v.run_id,v.status,v.assessment,v.input,v.error from pat_result_assessments v join pat_test_runs r on r.id=v.run_id join pat_mission_attempts a on a.id=r.mission_attempt_id where a.mission_id in ${tx(ids)} and v.runtime=${runtime} limit 200`,
      tx`select id,status,item_id,attempts,error,document,usage,lease_until,read_receipts,finished_at from pat_mission_reports where mission_id in ${tx(ids)} limit 30`,
      tx`select id,state,owner,attempt_id from pat_mission_resource_claims where workspace_id=${workspaceId}`,
      tx`select kind,payload,created_at from pat_mission_events where mission_id in ${tx(ids)} order by revision limit 2000`,
      tx`select c.id,c.run_id,c.item_id,c.url,c.action,c.error,i.provenance,i.content,i.deleted_at from pat_test_captures c join pat_test_runs r on r.id=c.run_id join pat_mission_attempts a on a.id=r.mission_attempt_id left join pat_workspace_items i on i.id=c.item_id where a.mission_id in ${tx(ids)} limit 241`,
      tx`select id,session_id,agent_id from pat_browser_assignments where workspace_id=${workspaceId}`,
      tx`select r.id,r.runtime,r.config,r.job from pat_repository_runs r where r.workspace_id=${workspaceId} and r.runtime=${runtime} and r.config->'execution'->>'missionId' in ${tx(ids)} limit 50`,
      tx`select id,workspace_id,runtime,status,result,autonomy from pat_setup_jobs where workspace_id=${workspaceId} and runtime=${runtime} and autonomy->'execution'->>'missionId' in ${tx(ids)} limit 50`,
      tx`select id,state,definition,deadline_at from pat_mission_waits where mission_id in ${tx(ids)} limit 100`,
      tx`select i.id,i.version,i.deleted_at from pat_workspace_items i join pat_mission_reports r on r.item_id=i.id where r.mission_id in ${tx(ids)}`,
    ]);
    const result = { missions, tasks, attempts, jobs, runs, reviews, reports, claims, events, captures, browsers, repositories, setups, waits, reportItems };
    for (const [name, cap] of Object.entries({ missions: 20, tasks: 250, attempts: 250, runs: 100, reviews: 200, reports: 30, events: 2000, captures: 241, repositories: 50, setups: 50, waits: 100 })) if (result[name].length >= cap) throw new Error('Frozen read-only observation bound reached: ' + name);
    return result;
  });
}

export async function observeRepoPreparation(sql, workspaceId, runtime) {
  const [setups, consents, vault, activeMissions, claims] = await Promise.all([
    sql`select id,workspace_id,runtime,status,result,autonomy from pat_setup_jobs where workspace_id=${workspaceId} and runtime=${runtime}`,
    sql`select id,user_id,workspace_id,runtime,grant_setup_job_id,repo_url,plan_hash,allowed_names,vault_revision,revision,expires_at,revoked_at from pat_environment_consents where workspace_id=${workspaceId} and runtime=${runtime}`,
    sql`select repo_url,environment,revision from pat_project_environments where workspace_id=${workspaceId}`,
    sql`select id from pat_missions where workspace_id=${workspaceId} and lifecycle!='closed'`,
    sql`select id from pat_mission_resource_claims where workspace_id=${workspaceId}`,
  ]);
  return { setups, consents, vault, activeMissions, claims };
}
