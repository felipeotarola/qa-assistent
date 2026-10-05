// Requires a disposable fixture created with KEEP_MISSION_FIXTURE=1.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
if (process.env.RUN_MISSION_REPORT_TESTS !== '1') throw new Error('Set RUN_MISSION_REPORT_TESTS=1 to use the disposable fixture.');
const f=JSON.parse(await readFile('.data/mission-fixture.json','utf8'));
const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
const origin='http://localhost:3000';
const call=async(input)=>{const r=await fetch(origin+'/api/internal/mission',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.INTERNAL_API_SECRET}`},body:JSON.stringify({userId:f.userId,threadId:f.threadId,...input})});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value).slice(0,100));return value;};
try{
 const second=await call({action:'create',requestId:randomUUID(),config:{title:'Automatisk rapport · separat uppdrag',goal:'Rapportera vad som återstår',scope:'Inga utförarjobb är beställda',criteria:[{id:'gap',text:'Redovisa att inga oberoende källor finns'}],target:null,caseKeys:[],automaticReports:true}});
 await sql`update pat_missions set updated_at=now()-interval '2 minutes',dirty_since=now()-interval '2 minutes',reconciled_at=now()-interval '2 minutes' where id=${second.id}`;
 // First reconcile can create selection revision. Second quiet period triggers generation.
 for(let i=0;i<2;i++){
  const r=await fetch(origin+'/api/internal/mission-reports/drain',{method:'POST',headers:{authorization:`Bearer ${process.env.INTERNAL_API_SECRET}`,'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);
  await sql`update pat_missions set updated_at=now()-interval '2 minutes',dirty_since=now()-interval '2 minutes',reconciled_at=now()-interval '2 minutes' where id=${second.id}`;
 }
 const reports=await sql`select * from pat_mission_reports where mission_id=${second.id}`;
 assert.equal(reports.length,1);assert.equal(reports[0].status,'completed');assert.equal(reports[0].model,'deterministic-rules');assert.equal(reports[0].document.tests.length,0);assert.ok(reports[0].document.findings.every(f=>f.verdict==='needs_evidence'));
 assert.equal((await sql`select count(*)::int n from pat_mission_reports where mission_id=${f.missionId}`)[0].n,1,'Other mission cannot be implicitly included or regenerated');
 for (const role of ['anon','authenticated']) for(const table of ['pat_missions','pat_mission_tasks','pat_mission_events','pat_mission_snapshots','pat_mission_reports','pat_report_shares','pat_report_share_sessions','pat_report_share_attempts','pat_report_share_audit']) {
  try { await sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);const rows=await tx.unsafe(`select * from ${table} limit 1`);assert.equal(rows.length,0,`${role} must not read ${table}`);}); }
  catch(e){if(e.code!=='42501') throw e;}
 }
 const flags=await sql`select relname,relrowsecurity from pg_class where relname in ('pat_missions','pat_mission_tasks','pat_mission_events','pat_mission_snapshots','pat_mission_reports','pat_report_shares','pat_report_share_sessions','pat_report_share_attempts','pat_report_share_audit')`;assert.equal(flags.length,9);assert.ok(flags.every(r=>r.relrowsecurity));
 console.log('PASS automatic report/debounce/dedup, evidence-free deterministic gap, separate same-workspace missions and RLS/direct-table denial for anon and authenticated');
}finally{await sql.end();}
