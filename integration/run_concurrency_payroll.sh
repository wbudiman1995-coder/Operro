#!/usr/bin/env bash
# Two real authenticated sessions recompute and then pay the same unused cycle.
# Run against a disposable, seeded database. Required env: DATABASE_URL,
# PAYROLL_TEST_ORG_ID, PAYROLL_TEST_USER_ID, PAYROLL_TEST_START, PAYROLL_TEST_END.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${PAYROLL_TEST_ORG_ID:?PAYROLL_TEST_ORG_ID is required}"
: "${PAYROLL_TEST_USER_ID:?PAYROLL_TEST_USER_ID is required}"
: "${PAYROLL_TEST_START:?PAYROLL_TEST_START is required}"
: "${PAYROLL_TEST_END:?PAYROLL_TEST_END is required}"
uuid='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
date='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
[[ "$PAYROLL_TEST_ORG_ID" =~ $uuid && "$PAYROLL_TEST_USER_ID" =~ $uuid ]] || { echo 'invalid UUID' >&2; exit 2; }
[[ "$PAYROLL_TEST_START" =~ $date && "$PAYROLL_TEST_END" =~ $date ]] || { echo 'invalid date' >&2; exit 2; }

psql_check() { psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 "$@"; }
before=$(psql_check -c "select count(*) from public.payroll_runs where organization_id='$PAYROLL_TEST_ORG_ID' and period_start='$PAYROLL_TEST_START' and period_end='$PAYROLL_TEST_END';")
[[ "$before" == 0 ]] || { echo 'test period is already used' >&2; exit 2; }

tmp=$(mktemp -d /tmp/operro-payroll-race.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
claims="{\"sub\":\"$PAYROLL_TEST_USER_ID\",\"active_org_id\":\"$PAYROLL_TEST_ORG_ID\",\"role\":\"authenticated\"}"
auth_call() {
  psql_check -c "begin; set local role authenticated; set local request.jwt.claims = '$claims'; $1; commit;"
}

recompute="select app.recompute_payroll_run('$PAYROLL_TEST_START'::date,'$PAYROLL_TEST_END'::date,null)"
auth_call "$recompute" >"$tmp/recompute-a" 2>"$tmp/recompute-a.err" & a=$!
auth_call "$recompute" >"$tmp/recompute-b" 2>"$tmp/recompute-b.err" & b=$!
if ! wait "$a"; then cat "$tmp/recompute-a.err" >&2; exit 1; fi
if ! wait "$b"; then cat "$tmp/recompute-b.err" >&2; exit 1; fi
run_a=$(tr -d '[:space:]' <"$tmp/recompute-a")
run_b=$(tr -d '[:space:]' <"$tmp/recompute-b")
[[ "$run_a" =~ $uuid && "$run_a" == "$run_b" ]] || { echo "recompute returned different runs: $run_a / $run_b" >&2; exit 1; }
count=$(psql_check -c "select count(*) from public.payroll_runs where id='$run_a';")
[[ "$count" == 1 ]] || { echo "expected one run, found $count" >&2; exit 1; }
echo "RECOMPUTE_RACE same_id=$run_a run_count=$count"

auth_call "select (app.approve_payroll_run('$run_a'::uuid)).status" >"$tmp/approve"
[[ "$(tr -d '[:space:]' <"$tmp/approve")" == approved ]] || { echo 'approve failed' >&2; exit 1; }

pay="select (app.pay_payroll_run('$run_a'::uuid)).status"
auth_call "$pay" >"$tmp/pay-a" 2>"$tmp/pay-a.err" & a=$!
auth_call "$pay" >"$tmp/pay-b" 2>"$tmp/pay-b.err" & b=$!
if ! wait "$a"; then cat "$tmp/pay-a.err" >&2; exit 1; fi
if ! wait "$b"; then cat "$tmp/pay-b.err" >&2; exit 1; fi
[[ "$(tr -d '[:space:]' <"$tmp/pay-a")" == paid && "$(tr -d '[:space:]' <"$tmp/pay-b")" == paid ]] || { echo 'pay call did not return paid' >&2; exit 1; }
result=$(psql_check -F '|' -c "select r.status,count(l.*),coalesce(sum(l.amount),0),r.total_net from public.payroll_runs r left join public.financial_ledger l on l.payroll_run_id=r.id and l.entry_type='payroll_paid' where r.id='$run_a' group by r.id;")
IFS='|' read -r status ledger_count ledger_amount total_net <<<"$result"
[[ "$status" == paid && "$ledger_count" == 1 ]] || { echo "unexpected pay result: $result" >&2; exit 1; }
net_ok=$(psql_check -c "select (coalesce(sum(l.amount),0)=-r.total_net)::int from public.payroll_runs r join public.financial_ledger l on l.payroll_run_id=r.id and l.entry_type='payroll_paid' where r.id='$run_a' group by r.id;")
[[ "$net_ok" == 1 ]] || { echo "ledger amount differs from payout: $result" >&2; exit 1; }
echo "PAY_RACE status=$status ledger_rows=$ledger_count ledger_amount=$ledger_amount total_net=$total_net"
echo 'PASS two authenticated sessions; one run and one payout ledger row'
