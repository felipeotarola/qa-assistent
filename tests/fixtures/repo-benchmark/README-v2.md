# Repository normal acceptance v2

`tests/autonomy-repository-v2.acceptance.mjs` is an explicitly new normal protocol,
`syna-repository-normal-v2`. The v1 entry and oracle remain available and unchanged.
No historical failed artifact is reclassified by this revision.

V2 permits at most two server-authorized P3 complements for an unresolved case.
Before selecting a later result, the read-only audit requires:

- The original case selection, criteria, target, plan/mandate epochs and mission
  deadline were observed before the first browser run and remain unchanged.
- Every run snapshot equals its exact case in the saved plan version. Every review
  retains all original checkpoint texts. The `runChecks` source bytes match both
  frozen services before submission and after closure; that hash is in the receipt.
- The original run/result remains in the observed history, and each complement
  has the exact preceding review, source/input hashes, gap IDs, dependency,
  round, server event, plan version, target and mandate binding.
- Actual run start/finish lie within the saved attempt and original mission
  deadlines. A controller acknowledgment arriving later does not move those times.
- Already supported cases cannot be rerun. A verified mismatch in a case with a
  separate unresolved gap cannot be erased by the complement.
- The final report selects exactly the current run per original case. Each
  checkpoint cites actual read bytes from that run, with the unchanged v1 HTTP,
  fixture outcome, setup/commit, cleanup and report-citation checks.

This is a structural and observed-effect audit. It does not parse natural-language
conjunctions or prove that a review understood every subcondition. Independent
reading of the original requirements, evidence and final prose remains mandatory;
`gate` stays false and semantic coverage is explicitly pending. In particular, the
failed 33bad REPO-11 trial remains failed for both its original v1 oracle outcome
and the independently observed missing-link/version-reporting defects.

Use a newly bound manifest for the current app and physical worker. Run `--audit`
before `--execute`; use three repetitions and fail-fast defaults. `--audit` makes
read-only SQL/process observations. Only `--execute` submits natural user prompts.
Do not use this harness to replay or recertify old trials. Repository fault
protocols remain separate and are not upgraded by this normal protocol.

Pure tests: `pnpm exec node --test tests/repo-benchmark-v2.test.mjs`.
No actual v2 model acceptance has been run when this protocol was introduced.
