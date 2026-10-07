import assert from 'node:assert/strict';
import { fingerprint } from './evidence-acceptance.mjs';

/** Only the legacy scheduler's read-observation timestamp is volatile. Keep
 * lifecycle, revisions, updated_at, results, permissions and every content byte.
 * This exception is explicit; the complete hash is also retained for diagnosis. */
export function securityProtectedRow(table, row) {
  if (table !== 'pat_missions') return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'reconciled_at'));
}

/** Hash workspace-owned rows inside one read-only snapshot, including
 * child tables. Neither private documents nor credentials leave this helper.
 * This proves persisted before/after state, not omniscience about transient
 * insert-then-delete side effects outside the durable product pathways. */
export async function securityWorkspaceFingerprint(sql, workspaceId) {
  return sql.begin('isolation level repeatable read read only', async tx => {
    const columns = await tx`select table_name,column_name from information_schema.columns where table_schema='public' and table_name like 'pat_%'`;
    const tables = new Map();
    for (const { table_name, column_name } of columns) {
      assert.match(table_name, /^pat_[a-z0-9_]+$/);
      const list = tables.get(table_name) ?? []; list.push(column_name); tables.set(table_name, list);
    }
    const scopes = {
      workspace_id: tx`workspace_id=${workspaceId}`,
      mission_id: tx`mission_id in (select id from pat_missions where workspace_id=${workspaceId})`,
      item_id: tx`item_id in (select id from pat_workspace_items where workspace_id=${workspaceId})`,
      run_id: tx`run_id in (select id from pat_test_runs where workspace_id=${workspaceId})`,
      thread_id: tx`thread_id in (select id from pat_threads where workspace_id=${workspaceId})`,
    };
    const result = [];
    for (const [table, cols] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
      const scope = table === 'pat_workspaces' ? tx`id=${workspaceId}` : scopes[Object.keys(scopes).find(key => cols.includes(key))];
      if (!scope) continue;
      const rows = await tx`select to_jsonb(t) as row from ${tx(table)} t where ${scope}`;
      result.push({ table, rows: rows.length,
        sha256: fingerprint(rows.map(r => fingerprint(securityProtectedRow(table, r.row))).sort()),
        fullSha256: fingerprint(rows.map(r => fingerprint(r.row)).sort()) });
    }
    assert.ok(result.some(r => r.table === 'pat_workspaces' && r.rows === 1), 'Security workspace must exist');
    return { sha256: fingerprint(result.map(row => ({ table: row.table, rows: row.rows, sha256: row.sha256 }))), fullSha256: fingerprint(result),
      excludedObservationFields: ['pat_missions.reconciled_at'], tables: result };
  });
}
