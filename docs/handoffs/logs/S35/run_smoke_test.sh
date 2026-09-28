#!/usr/bin/env bash
set -uo pipefail
REPO=/mnt/e/Claude/operro-retention-s35
LOG=$REPO/docs/handoffs/logs/S35/retention_renewal_followups_smoke.log

docker start operro_pg16_gate >>"$LOG" 2>&1
sleep 2
docker exec operro_pg16_gate pg_isready -U postgres >>"$LOG" 2>&1

# Clean up any rows left over from an earlier partial-commit run of this same script
# (safe/idempotent: cascades from organizations, matches this file's own fixture ids).
docker exec -i -e PGUSER=postgres -e PGPASSWORD=postgres operro_pg16_gate \
  psql -d operro_gate -v ON_ERROR_STOP=1 -c \
  "delete from public.organizations where id in ('04000000-0000-4000-8000-000000000001','04000000-0000-4000-8000-000000000002');" \
  >>"$LOG" 2>&1

echo "=== $(date -Is) rerunning smoke test ===" >>"$LOG"
docker exec -i -e PGUSER=postgres -e PGPASSWORD=postgres operro_pg16_gate \
  psql -d operro_gate -v ON_ERROR_STOP=1 < "$REPO/integration/retention_renewal_followups_smoke.sql" >>"$LOG" 2>&1
echo "smoke test exit=$?" >>"$LOG"
