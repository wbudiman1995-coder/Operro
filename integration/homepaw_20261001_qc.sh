#!/usr/bin/env bash
# Regression bundle for the 2026-10-01 access, catalog, and billing rollout.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGUSER=postgres
bash integration/homepaw_qc_db.sh
psql operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/homepaw_qc_smoke.sql
psql operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/homepaw_size_membership_smoke.sql
psql operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/homepaw_review_storage_smoke.sql
