#!/usr/bin/env bash
# Run the committed integration tree against its own disposable PostgreSQL 16.
# This does not touch any engine's Supabase stack or database.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scratch=$(mktemp -d /tmp/operro-combined.XXXXXX)
wrappers=$(mktemp -d /tmp/operro-combined-bin.XXXXXX)
container="operro_combined_pg16_$$"
log="$repo/docs/handoffs/logs/INTEGRATION/run_all_gates.log"
mkdir -p "$(dirname "$log")"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# WSL cannot resolve this Windows-created worktree's E:-absolute .git pointer.
# Copy the clean checkout directly, omitting local dependencies and this run's log.
tar -C "$repo" --exclude=.git --exclude=node_modules --exclude=.next --exclude=.env.local \
  --exclude=docs/handoffs/logs/INTEGRATION -cf - . | tar -xf - -C "$scratch"
find "$scratch" -type f -name '*.sh' -exec sed -i 's/\r$//' {} +

docker run -d --name "$container" -e POSTGRES_PASSWORD=postgres \
  -v "$scratch:$scratch" -v /tmp:/tmp postgres:16 >/dev/null
for i in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres >/dev/null

for command in psql createdb dropdb; do
  cat > "$wrappers/$command" <<'WRAPPER'
#!/usr/bin/env bash
exec docker exec -i -w "$PWD" -e PGHOST=127.0.0.1 -e PGPORT=5432 \
  -e PGUSER=postgres -e PGPASSWORD=postgres "$OPERRO_GATE_CONTAINER" "$(basename "$0")" "$@"
WRAPPER
  chmod +x "$wrappers/$command"
done

export OPERRO_GATE_CONTAINER="$container"
export PATH="$wrappers:$PATH"
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres
export RUN_AS_POSTGRES=0
cd "$scratch"

echo "Integration checkout: $repo" > "$log"
echo "PostgreSQL: $(docker exec "$container" psql -U postgres -Atc 'show server_version')" >> "$log"
if bash run_all_gates.sh >> "$log" 2>&1; then
  echo 'run_all_gates.sh exit=0' >> "$log"
  tail -30 "$log"
else
  result=$?
  echo "run_all_gates.sh exit=$result" >> "$log"
  tail -100 "$log"
  exit "$result"
fi
