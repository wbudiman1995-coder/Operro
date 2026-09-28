#!/usr/bin/env bash
# Runs run_all_gates.sh (and, once written, the new S35 SQL smoke test) against the
# disposable `operro_pg16_gate` container via docker exec, since WSL2 mirrored
# networking makes the published port unreachable from the host and this WSL distro
# has no native postgres client. Everything happens in ONE continuous shell session
# (this script), because the container has been observed to stop between SEPARATE
# `wsl -d Ubuntu` invocations from the calling tool -- staying inside one script
# avoids that gap entirely.
set -uo pipefail

REPO=/mnt/e/Claude/operro-retention-s35
LOG=$REPO/docs/handoffs/logs/S35/run_all_gates.log
WRAP=/tmp/s35-pg16-wrappers
mkdir -p "$WRAP"

echo "=== $(date -Is) starting operro_pg16_gate ===" | tee "$LOG"
# Always recreate: GATE 8's concurrency harness copies itself to a HOST /tmp dir and
# references those paths in -f arguments piped through the psql wrapper below, which
# execs into the container -- so /tmp must be bind-mounted too, and mounts are fixed at
# container-creation time (a plain `docker start` on an existing container without this
# mount does not add it). The container is disposable, so recreating is cheap and safe.
docker rm -f operro_pg16_gate >>"$LOG" 2>&1
docker run -d --name operro_pg16_gate -e POSTGRES_PASSWORD=postgres -v "$REPO":/work -v /tmp:/tmp postgres:16 >>"$LOG" 2>&1
sleep 4
docker exec operro_pg16_gate pg_isready -U postgres >>"$LOG" 2>&1

for bin in psql createdb dropdb; do
  cat > "$WRAP/$bin" <<EOF
#!/usr/bin/env bash
# docker exec does NOT inherit the caller's env vars -- PGUSER/PGPASSWORD must be
# passed explicitly with -e, or every call defaults to connecting as OS user "root"
# (which has no matching Postgres role in this image) instead of "postgres".
exec docker exec -i -e PGUSER=postgres -e PGPASSWORD=postgres -w /work operro_pg16_gate $bin "\$@"
EOF
  chmod +x "$WRAP/$bin"
done

export PATH="$WRAP:$PATH"
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER=postgres
export PGPASSWORD=postgres
export RUN_AS_POSTGRES=0

cd "$REPO"
# run_all_gates.sh is CRLF-terminated (Windows-authored, git-tracked as-is) --
# `set -euo pipefail\r` fails under bash on Linux ("pipefail: invalid option
# name"). Run a CRLF-stripped copy rather than editing the tracked file.
sed 's/\r$//' run_all_gates.sh > /tmp/run_all_gates_lf.sh
chmod +x /tmp/run_all_gates_lf.sh
echo "=== $(date -Is) running run_all_gates.sh (CRLF-stripped copy) ===" | tee -a "$LOG"
bash /tmp/run_all_gates_lf.sh >>"$LOG" 2>&1
echo "run_all_gates.sh exit=$?" | tee -a "$LOG"
