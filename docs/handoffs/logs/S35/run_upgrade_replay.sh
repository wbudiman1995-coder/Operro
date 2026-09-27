#!/usr/bin/env bash
set -uo pipefail
REPO=/mnt/e/Claude/operro-retention-s35
LOG=$REPO/docs/handoffs/logs/S35/migration_upgrade_replay.log
WRAP=/tmp/s35-pg16-wrappers
mkdir -p "$WRAP"

docker start operro_pg16_gate >>"$LOG" 2>&1
sleep 2
docker exec operro_pg16_gate pg_isready -U postgres >>"$LOG" 2>&1

for bin in psql createdb dropdb; do
  cat > "$WRAP/$bin" <<EOF
#!/usr/bin/env bash
exec docker exec -i -e PGUSER=postgres -e PGPASSWORD=postgres -w /work operro_pg16_gate $bin "\$@"
EOF
  chmod +x "$WRAP/$bin"
done
export PATH="$WRAP:$PATH"
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres

cd "$REPO"
sed 's/\r$//' integration/migration_upgrade_replay.sh > /tmp/migration_upgrade_replay_lf.sh
chmod +x /tmp/migration_upgrade_replay_lf.sh
echo "=== $(date -Is) running migration_upgrade_replay.sh (CRLF-stripped, unmodified content) ===" | tee -a "$LOG"
bash /tmp/migration_upgrade_replay_lf.sh >>"$LOG" 2>&1
echo "migration_upgrade_replay.sh exit=$?" | tee -a "$LOG"
