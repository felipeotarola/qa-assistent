import { test } from "node:test";
import assert from "node:assert/strict";
import { replayExternalReceipt, finishExternalWrite } from "../server/utils/external-receipts.ts";

const result = { id: "42", title: "Bug", body: "Details", url: "https://github.com/example/qa/issues/42" };
test("only completed matching operations replay; uncertain and changed requests cannot", () => {
  assert.deepEqual(replayExternalReceipt({ fingerprint: "same", state: "complete", result }, "same"), result);
  for (const state of ["pending", "unknown", "failed"]) assert.throws(() => replayExternalReceipt({ fingerprint: "same", state, result }, "same"), /pending or its outcome is unknown/);
  assert.throws(() => replayExternalReceipt({ fingerprint: "same", state: "complete", result }, "changed"), /different content or destination/);
  assert.throws(() => replayExternalReceipt({ fingerprint: "same", state: "complete", result: null }, "same"));
});
test("network timeout records uncertainty and never retries mutation", async () => {
  let writes = 0;
  const records = [];
  await assert.rejects(finishExternalWrite(async () => { writes++; throw new Error("timeout after remote commit"); }, async state => { records.push(state); }), /Could not confirm/);
  assert.equal(writes, 1);
  assert.deepEqual(records, ["unknown"]);
});
test("receipt persistence failure does not report successful publication or retry", async () => {
  let writes = 0;
  const records = [];
  await assert.rejects(finishExternalWrite(async () => { writes++; return result; }, async state => { records.push(state); if (state === "complete") throw new Error("DB unavailable"); }), /Could not confirm/);
  assert.equal(writes, 1);
  assert.deepEqual(records, ["complete", "unknown"]);
});
test("confirmed publication returns the actual provider result", async () => {
  const records = [];
  assert.deepEqual(await finishExternalWrite(async () => result, async (state, data) => { records.push({ state, data }); }), result);
  assert.deepEqual(records, [{ state: "complete", data: result }]);
});
