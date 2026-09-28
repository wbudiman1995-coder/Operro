#!/usr/bin/env bash
#
# S27-S30 closeout gate harness — run from WSL (needs Docker running inside
# the WSL distro). Adapted from Engine 1's engine1-checks.sh (same
# docker-exec psql/createdb/dropdb wrapper pattern), with two fixes specific
# to this branch's gate suite (see docs/handoffs/S27-S30-HANDOFF.md §11
# "Gate-harness notes" for why):
#   1. Docker mounts BOTH the scratch copy and /tmp itself — GATE 8's
#      concurrency case does mktemp -d /tmp/... outside the scratch dir.
#   2. lint/test:batch1a/test:batch1b/test:booking run from inside this same
#      WSL scratch copy, not from the Windows-side node_modules, which has a
#      linux-x64 esbuild binary installed and fails immediately on Windows node.
#
# Usage (from Windows Git Bash):
#   MSYS2_ARG_CONV_EXCL="*" wsl.exe -- bash /mnt/e/Claude/operro-sections-27-30/docs/handoffs/logs/S27-S30/closeout/run_gates_harness.sh
set -uo pipefail
SRC=/mnt/e/Claude/operro-sections-27-30
DEST=/tmp/operro-s2730-gate-run
LOG_OUT=/tmp/operro-s2730-gate-run-output.log
exec > "$LOG_OUT" 2>&1

echo "=== $(date) start ==="

echo "--- syncing scratch copy ---"
rm -rf "$DEST"
mkdir -p "$DEST"
( cd "$SRC" && tar -c --exclude=.git --exclude=node_modules --exclude='apps/web/.next' -f - . ) | ( cd "$DEST" && tar -xf - )

echo "--- normalizing CRLF in shell scripts ---"
find "$DEST" -name "*.sh" -type f -exec sed -i 's/\r$//' {} +

echo "--- checking npm registry reachability ---"
if curl -s -m 5 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ | grep -q 200; then
  echo "registry reachable, npm ci will run fresh inside run_all_gates.sh"
else
  echo "registry NOT reachable, copying node_modules from source (slow)"
  time cp -a "$SRC/node_modules" "$DEST/node_modules"
  time cp -a "$SRC/apps/web/node_modules" "$DEST/apps/web/node_modules" 2>/dev/null || true
  for d in "$SRC"/packages/*/node_modules; do
    [ -d "$d" ] || continue
    pkg=$(basename "$(dirname "$d")")
    time cp -a "$d" "$DEST/packages/$pkg/node_modules"
  done
fi

echo "--- starting disposable postgres 16 container ---"
docker rm -f operro_s2730_closeout >/dev/null 2>&1 || true
docker run -d --name operro_s2730_closeout -e POSTGRES_PASSWORD=postgres -v "$DEST:$DEST" -v /tmp:/tmp postgres:16
for i in $(seq 1 60); do
  docker exec operro_s2730_closeout pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

BIN=$(mktemp -d /tmp/operro-s2730-bin.XXXXXX)
for cmd in psql createdb dropdb; do
cat > "$BIN/$cmd" <<'WRAPPER'
#!/usr/bin/env bash
exec docker exec -i -w "$PWD" -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER="${PGUSER:-postgres}" -e PGPASSWORD="${PGPASSWORD:-postgres}" operro_s2730_closeout "$(basename "$0")" "$@"
WRAPPER
chmod +x "$BIN/$cmd"
done

export PATH="$BIN:$PATH"
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres

cd "$DEST"
echo "--- running run_all_gates.sh ---"
bash run_all_gates.sh
GATE_RC=$?
echo "run_all_gates.sh exit=$GATE_RC"

echo "--- lint (apps/web) ---"
npm run lint -w apps/web
LINT_RC=$?
echo "lint exit=$LINT_RC"

echo "--- test:batch1a (apps/web) ---"
npm run test:batch1a -w apps/web
BATCH1A_RC=$?
echo "test:batch1a exit=$BATCH1A_RC"

echo "--- test:batch1b (apps/web) ---"
npm run test:batch1b -w apps/web
BATCH1B_RC=$?
echo "test:batch1b exit=$BATCH1B_RC"

# test:booking has a documented pre-existing failure (Engine 1 integration
# boundary, not a regression from this branch's work) — run it and record
# its exit code honestly, but never let it mask or block the rest of this
# suite's result.
echo "--- test:booking (apps/web) — pre-existing baseline failure expected ---"
npm run test:booking -w apps/web
BOOKING_RC=$?
echo "test:booking exit=$BOOKING_RC (non-blocking, see handoff for the known baseline failure)"

OVERALL_RC=0
[ "$GATE_RC" = "0" ] || OVERALL_RC=1
[ "$LINT_RC" = "0" ] || OVERALL_RC=1
[ "$BATCH1A_RC" = "0" ] || OVERALL_RC=1
[ "$BATCH1B_RC" = "0" ] || OVERALL_RC=1

echo "=== $(date) done, rc=$OVERALL_RC (gate=$GATE_RC lint=$LINT_RC batch1a=$BATCH1A_RC batch1b=$BATCH1B_RC booking=$BOOKING_RC) ==="
mkdir -p "$SRC/docs/handoffs/logs/S27-S30/closeout"
cp "$LOG_OUT" "$SRC/docs/handoffs/logs/S27-S30/closeout/run_all_gates_full.log"
exit $OVERALL_RC
