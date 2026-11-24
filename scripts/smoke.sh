#!/usr/bin/env bash
# Post-deploy smoke test. Read-only: it never creates or changes data.
#   BASE_URL=https://your-api.example.com ./scripts/smoke.sh
set -uo pipefail
BASE="${BASE_URL:-http://localhost:3004}"; BASE="${BASE%/}"
pass=0; fail=0
check() { # name expected_status actual_status
  if [[ "$3" == "$2" ]]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@" || echo 000; }

check "server is up (public program templates)"        200 "$(code "$BASE/users/training-programs")"
check "no public user list (was a data leak)"          404 "$(code "$BASE/users")"
check "profile requires a login"                       401 "$(code "$BASE/users/me")"
check "garbage token is a 401, not a 500"              401 "$(code -H 'Authorization: Bearer nope' "$BASE/users/me")"
check "refresh rejects a bad token"                    401 "$(code -X POST -H 'Content-Type: application/json' -d '{"refreshToken":"x"}' "$BASE/auth/refresh")"
check "password reset answers (never reveals accounts)" 200 "$(code -X POST -H 'Content-Type: application/json' -d '{"email":"smoke-test-nobody@invalid.example"}' "$BASE/auth/password/forgot")"
check "OAuth refuses an arbitrary redirect"            400 "$(code "$BASE/auth/google?state=mobile&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal")"

ACAO=$(curl -s -m 15 -D - -o /dev/null -H 'Origin: https://evil.example' "$BASE/users/training-programs" | grep -i '^access-control-allow-origin' || true)
if [[ -z "$ACAO" ]]; then echo "PASS  CORS does not allow an unknown origin"; pass=$((pass+1)); else echo "FAIL  CORS allows an unknown origin: $ACAO"; fail=$((fail+1)); fi

if [[ "$BASE" == https://* ]]; then
  HSTS=$(curl -s -m 15 -D - -o /dev/null "$BASE/users/training-programs" | grep -i '^strict-transport-security' || true)
  if [[ -n "$HSTS" ]]; then echo "PASS  HSTS header present"; pass=$((pass+1)); else echo "FAIL  HSTS header missing (is NODE_ENV=production?)"; fail=$((fail+1)); fi
fi

echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
