#!/usr/bin/env bash
# Smoke test for a running Product Service.
#
#   scripts/smoke-test.sh                                   # local: http://localhost:3000
#   scripts/smoke-test.sh "http://$(out LoadBalancerDnsName)"   # through the AWS load balancer
#
# Waits up to WAIT_SECONDS (default 60) for /health, then checks every
# endpoint. Exits non-zero with a message on the first failure.
# Needs curl and jq.
set -euo pipefail

BASE="${1:-http://localhost:3000}"
BASE="${BASE%/}"
WAIT_SECONDS="${WAIT_SECONDS:-60}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }

# status <path> -> prints the HTTP status code
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE$1" || true; }

echo "Smoke test against $BASE"

for ((i = 0; i < WAIT_SECONDS; i += 2)); do
  [ "$(status /health)" = "200" ] && break
  sleep 2
done
[ "$(status /health)" = "200" ] || fail "/health did not return 200 within ${WAIT_SECONDS}s (last: $(status /health))"
pass "/health is 200"

health=$(curl -sf --max-time 5 "$BASE/health")
[ "$(jq -r .database <<<"$health")" = "up" ] || fail "/health reports database: $(jq -r .database <<<"$health")"
pass "/health reports the database up"

[ "$(status /health/live)" = "200" ] || fail "/health/live is not 200"
pass "/health/live is 200"

products=$(curl -sf --max-time 5 "$BASE/products") || fail "/products did not return 2xx"
count=$(jq 'if type == "array" then length else -1 end' <<<"$products")
[ "$count" -ge 1 ] || fail "/products is not a non-empty array: $products"
jq -e '.[0] | (.id | type == "number") and (.name | type == "string") and (.price | type == "number")' \
  <<<"$products" >/dev/null || fail "/products items don't have id, name and a numeric price: $(jq -c '.[0]' <<<"$products")"
pass "/products returns $count products with id, name and numeric price"

headers=$(curl -s -D - -o /dev/null --max-time 5 "$BASE/does-not-exist")
grep -q '^HTTP/[0-9.]* 404' <<<"$headers" || fail "unknown path did not return 404"
grep -qi '^x-request-id:' <<<"$headers" || fail "no x-request-id header"
if grep -qi '^x-powered-by:' <<<"$headers"; then fail "x-powered-by header is exposed"; fi
pass "unknown path is 404 with x-request-id and no x-powered-by"

echo "All smoke checks passed"
