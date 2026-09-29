#!/usr/bin/env bash
# Two genuine PostgreSQL sessions against an isolated, seeded local Supabase DB.
# Never point this at production. Requires explicit local container name.
set -euo pipefail

container="${OPERRO_LOCAL_DB_CONTAINER:?set the isolated local Supabase DB container name}"
case "$container" in
  supabase_db_operro-combined-local) ;;
  *) echo "Refusing unexpected DB container: $container" >&2; exit 2 ;;
esac

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
log="$repo/docs/handoffs/logs/INTEGRATION/payment-concurrency.log"
work=$(mktemp -d /tmp/operro-payment-race.XXXXXX)
invoice_number="${OPERRO_RACE_INVOICE_NUMBER:-DEMO-INV-003}"
[[ "$invoice_number" =~ ^[A-Z0-9-]+$ ]] || { echo "Invalid isolated invoice number" >&2; exit 2; }
invoice_id=$(docker exec "$container" psql -U postgres -d postgres -Atc "select id from public.invoices where invoice_number='$invoice_number' and status='issued'")
if [[ ! "$invoice_id" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "Expected isolated issued invoice $invoice_number; found: $invoice_id" >&2
  exit 2
fi
invoice_total=$(docker exec "$container" psql -U postgres -d postgres -Atc "select total::bigint from public.invoices where id='$invoice_id'")
[[ "$invoice_total" =~ ^[0-9]+$ ]] || { echo "Invalid invoice total" >&2; exit 2; }
amount_a=$((invoice_total / 2))
amount_b=$((invoice_total - amount_a + 50000))

write_session() {
  local path="$1" key="$2" amount="$3" pause="$4"
  cat > "$path" <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-000000000001","active_org_id":"d0000000-0000-4000-8000-000000000001"}', true);
select clock_timestamp() as before_record;
select id, request_key, amount from app.record_payment('$invoice_id', 'cash', $amount, 'RACE-$key', null, '$key');
select clock_timestamp() as after_record;
select pg_sleep($pause);
commit;
SQL
}

run_session() { docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$1" > "$2" 2>&1; }

same_key=$(cat /proc/sys/kernel/random/uuid)
write_session "$work/same_a.sql" "$same_key" 1000 2
write_session "$work/same_b.sql" "$same_key" 1000 0
run_session "$work/same_a.sql" "$work/same_a.out" & first=$!
sleep 0.4
run_session "$work/same_b.sql" "$work/same_b.out" & second=$!
wait "$first"
wait "$second"

same_count=$(docker exec "$container" psql -U postgres -d postgres -Atc "select count(*) from public.payments where request_key='$same_key'")
[[ "$same_count" == 1 ]] || { echo "same-key race produced $same_count payments" >&2; exit 1; }

key_a=$(cat /proc/sys/kernel/random/uuid)
key_b=$(cat /proc/sys/kernel/random/uuid)
write_session "$work/compete_a.sql" "$key_a" "$amount_a" 2
write_session "$work/compete_b.sql" "$key_b" "$amount_b" 0
run_session "$work/compete_a.sql" "$work/compete_a.out" & first=$!
sleep 0.4
run_session "$work/compete_b.sql" "$work/compete_b.out" & second=$!
wait "$first"
wait "$second"

{
  echo "invoice=$invoice_id"
  echo "invoice_number=$invoice_number invoice_total=$invoice_total independent_amounts=$amount_a+$amount_b"
  echo "same_request_key=$same_key"
  echo "=== same-key session A ==="; cat "$work/same_a.out"
  echo "=== same-key session B ==="; cat "$work/same_b.out"
  echo "same-key payment count=$same_count"
  echo "=== competing session A ==="; cat "$work/compete_a.out"
  echo "=== competing session B ==="; cat "$work/compete_b.out"
  echo "=== final database state ==="
  docker exec "$container" psql -U postgres -d postgres -c "select i.invoice_number,i.status,i.total,i.metadata->>'overpaid_amount' as overpaid_amount,count(p.id) as payment_count,sum(p.amount) as paid_total from public.invoices i join public.payments p on p.invoice_id=i.id where i.id='$invoice_id' group by i.id"
} > "$log"

grep -q 'overpaid_amount' "$log"
grep -q '51000' "$log"
echo "PASS: same-key retry produced one payment; independent concurrent payments serialized. Raw log: $log"
