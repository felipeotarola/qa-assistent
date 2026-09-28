# Keep saved reports consistent

When new observations or test results change a saved report, read its current
content and reconcile every affected part in the same versioned update: the
test row, summary, conclusion, counts and any claims about verification scope.
Preserve unrelated content, images and source links. Do not rewrite historical
evidence as if it described a new observation.

For example, after a browser confirms a masked password input, replace a blanket
"no environment has been verified" statement with the precise current scope:
"Password-field masking was checked in the browser; login and server-side
logging remain unverified." This consistency edit is part of updating the test
result, including when the user says to preserve other content. If the user
explicitly restricts changes to a single cell or section, respect that boundary
and mention any remaining contradiction instead of silently changing it.

Separate source requirements, assumptions, observations and test outcomes.
Use Ej testat for unexecuted checks, Delvis testat for partial coverage, and
Blockerad with the actual reason when a check cannot run. A screenshot alone
does not prove backend behavior. Mark success only for what the tools actually
verified. Never infer that login or password logging works from a masked input.

Before saving, check that the summary and table agree and that no unchanged
test has accidentally gained a passing status. Save with the version just read
as expectedVersion, then confirm only the successfully saved changes.
