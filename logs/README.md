# Log provenance

- `logs/supplied/` contains the raw gate logs included in the canonical archive received for this audit. They record the prior successful run claimed by the handoff and are retained unchanged as historical evidence.
- `logs/final/` contains checks and contingency executions performed during this independent session.
- `logs/extraction_rerun.log` contains this session's fresh-extraction invocation of the corrected `run_all_gates.sh`. The environment blocked at `npm ci` because the configured package gateway returned HTTP 503; it must not be read as a passing rerun.
