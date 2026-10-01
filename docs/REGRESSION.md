# Release regression

Run `pnpm test:regression` for the deterministic contracts. Run
`pnpm test:regression --live` with the local app running and the configured `.env`
for the sequential API/VPS suite. Use Node 24 through pnpm. Live tests consume
model/browser/runner capacity and create temporary fixtures which they clean up.
Do not run concurrent suites against the small shared connection pool.

The live suite covers:

- Immutable results, full-case pass validation, retries and workspace isolation.
- Requirement publication conflicts, provider failure and durable receipt recovery
  using a fake provider and a real database with two connections. No Linear writes.
- Missing environment configuration, encrypted vault values, names-only responses,
  stale revisions and terminal callback replay. This stage is API-only.
- Real VPS browser navigation, offscreen controls, unmet destinations and takeover.
- Three public Surdeg cases delegated to Iris: click navigation, unknown profile,
  and login return (intentionally blocked without an account). V must remain
  responsive, receive the terminal report and not restart completed work.
- Public is-stream repository execution and an idempotently saved Material report.
  A completed repository command is distinct from a passing product test.

Check the UI separately: open a case's run history, expand coverage, and verify
verified/blocked/missing observations at narrow and wide widths. Historical runs
without checklists must say that coverage was not documented. Human review and
the agent's original verdict remain separate. No checklist can independently
prove that the model's observations are true; retain screenshots and review
contradictory evidence.

## Verified 2026-10-01

The Surdeg pilot produced two passed cases and one blocked login-return case,
with five screenshots and per-check observations. V answered an unrelated QA
question while Iris ran, then received the report automatically (~83 seconds).
The API suite and real requirement transaction suite passed. The latter runs
with the same two-connection limit as the app, including local conflict recovery.

Publication uses a non-blocking workspace lock: concurrent attempts return a
busy response rather than consuming all connections waiting for one another.
Local reads reuse the active transaction. The earlier intermittent login timeout
was not conclusively attributed to this lock; it must not be described as proven
resolved by this change.
