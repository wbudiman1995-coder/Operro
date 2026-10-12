#!/usr/bin/env bash
# Start the web app against an already-running, isolated local Supabase stack.
# Reads keys from `supabase status`; it never prints or persists them.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project_id="${OPERRO_LOCAL_PROJECT_ID:-operro-combined-local}"
host="${OPERRO_LOCAL_WEB_HOST:-127.0.0.1}"
port="${OPERRO_LOCAL_WEB_PORT:-3003}"

[[ "$project_id" =~ ^[a-z0-9-]+$ ]] || { echo "Invalid local project id" >&2; exit 2; }
[[ "$host" =~ ^[A-Za-z0-9.:-]+$ ]] || { echo "Invalid local web host" >&2; exit 2; }
[[ "$port" =~ ^[0-9]{2,5}$ ]] || { echo "Invalid local web port" >&2; exit 2; }

scratch=$(mktemp -d /tmp/operro-browser-status.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/supabase"
cp "$repo/supabase/config.toml" "$scratch/supabase/config.toml"
sed -i -E "s/^project_id = .*/project_id = \"$project_id\"/" "$scratch/supabase/config.toml"

eval "$(supabase status -o env --workdir "$scratch")"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"

cd "$repo"
npm run dev --workspace web -- --hostname "$host" --port "$port"
