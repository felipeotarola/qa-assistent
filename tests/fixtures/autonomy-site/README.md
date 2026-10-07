# Autonomous QA website fixture

A dependency-free, immutable small Swedish storefront with normal navigation and product search. It contains one deliberate defect: the visible Returns navigation leads to a 404. The oracle is only for the acceptance harness, never served or included in a model prompt. No credentials, external scripts, purchases or user data are used.

The Linux fixture serves `server.mjs` read-only on HTTP port 80 in an internal Docker test network (`192.0.2.0/24`). Only the isolated browser is attached; its local hosts entry maps `qa-fixture.test` to `192.0.2.10`. Explicit fixture-network firewall rules allow only that HTTP destination. Product SSRF checks remain unchanged.

Research validates DNS in the Windows Nuxt process but loads pages through remote Chromium. Add the explicit Node preload `--import=<absolute file URL to resolver.mjs>` only to the isolated app process with `SYNA_AUTONOMY_SITE=fixture-v1` (on Windows, use `pathToFileURL(absolutePath).href`, not a raw drive-letter path). The resolver refuses non-test runtime scopes, non-loopback databases, Vercel and a browser endpoint other than the own Linux test browser. It changes only `qa-fixture.test` lookup; other hostnames retain normal DNS behavior. No system DNS, hosts file or routes change.

The environment is a **simulated public-origin network**, not a public Internet deployment. Pair it with an actual public URL scenario such as example.com. Freeze the SHA256 of `server.mjs` and the oracle in each run's artifact before submitting the natural prompt. The HTTP response exposes its server SHA in `x-fixture-sha256`; the oracle is never a route. Do not change this fixture midway through an acceptance matrix.

WEB acceptance protocol 6 binds the review version and input-hash format to
the identical `shared/result-assessment.ts` bytes in both verified service
snapshots before submission. It also records the harness and oracle hashes.
Historical protocol 5 retains its reviewer-6 expectation; never change old
artifacts to reinterpret a later reviewer as an original passing trial. A
post-hoc diagnostic of original bytes is separate from a new acceptance run.

The separate `tests/autonomy-public-url.acceptance.mjs` supplement is locked to
`https://example.com/`: read the homepage without following links, signing in or
submitting forms. With the owned isolated application/browser already running,
`pnpm exec node tests/autonomy-public-url.acceptance.mjs --audit` performs only
local readiness reads. Coordinate the actual model window before using
`--execute --repetitions=1` (up to three; fixed 1,500-second window per trial).
It creates fresh workspaces, submits one ordinary question, disconnects chat,
and observes the normal scheduler through read-only PostgreSQL. Real page
bytes, reviewed results, saved report and cleanup are checked afterward.
Its automatic subset is separate from the fixture matrix and independent
report-prose review; the remote page is not version-pinned and the helper never
awards the full acceptance gate.
