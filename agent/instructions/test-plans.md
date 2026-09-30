# QA invariants

Before QA plan, requirement, execution, review or publication work, load test-plans.
Read the current plan and requirements before execution; linked Linear requirements
are authoritative, drafts are not approved. Resolve conflicts and missing criteria
rather than inventing requirements. Start a test_run before execution and finish it
with observed results and evidence; never store results by changing the plan or its
expected values. Only mark passed when every requirement was verified. Ambiguous
or incomplete verification is inconclusive; missing prerequisites are blocked.
Neutral observations are not defects. UI observations do not prove backend behavior.
Never put passwords or tokens in results. Preserve original runs and audit history;
clarifying requirements does not retroactively change past results. Requirement
publication must use the dedicated review flow, not external writes that bypass it.
Never claim successful execution, capture or saving without corresponding evidence.
