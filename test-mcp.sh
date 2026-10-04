#!/bin/bash
# MCP Protocol Smoke Test for boc-fx
# Usage: Start your server first (PORT=8080 npm run dev &), then: bash test-mcp.sh
# Every /mcp curl includes -H "Accept: application/json, text/event-stream" (required).

BASE_URL="${MCP_URL:-http://localhost:8080}"
MCP_ENDPOINT="$BASE_URL/mcp"
HEALTH_ENDPOINT="$BASE_URL/health"
PASSED=0
FAILED=0

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}FAIL${NC} $1: $2"; FAILED=$((FAILED + 1)); }

mcp_post() { # $1 = id, $2 = json body
  curl -sf -X POST "$MCP_ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$2" 2>/dev/null || true
}

echo "Testing boc-fx at $BASE_URL"
echo "================================"

# 1. Health check
echo ""
echo "--- Health Check ---"
HEALTH=$(curl -sf "$HEALTH_ENDPOINT" 2>/dev/null) || true
if echo "$HEALTH" | grep -q "healthy"; then
  pass "GET /health returns healthy"
else
  fail "GET /health" "got: $HEALTH"
fi

# 2. Initialize
echo ""
echo "--- MCP Initialize ---"
INIT_RESPONSE=$(mcp_post 1 '{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26", "capabilities": {},
    "clientInfo": { "name": "smoke-test", "version": "1.0" }
  }
}') || true
if echo "$INIT_RESPONSE" | grep -q '"result"'; then
  pass "initialize returns result"
else
  fail "initialize" "got: ${INIT_RESPONSE:0:200}"
fi

# 3. List tools
echo ""
echo "--- List Tools ---"
TOOLS_RESPONSE=$(mcp_post 2 '{
  "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
}') || true
if echo "$TOOLS_RESPONSE" | grep -q '"tools"'; then
  pass "tools/list returns tools array"
  TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['result']['tools']))" 2>/dev/null || echo "?")
  echo "     Found $TOOL_COUNT tool(s)"
else
  fail "tools/list" "got: ${TOOLS_RESPONSE:0:200}"
fi

EXPECTED_TOOLS=("convert_currency" "fx_history" "latest_rates")
for TOOL in "${EXPECTED_TOOLS[@]}"; do
  if echo "$TOOLS_RESPONSE" | grep -q "\"$TOOL\""; then
    pass "Tool '$TOOL' is registered"
  else
    fail "Tool '$TOOL'" "Not found in tools/list response"
  fi
done

call_tool() { # $1 = id, $2 = tool name, $3 = arguments json
  mcp_post "$1" "{
    \"jsonrpc\": \"2.0\", \"id\": $1, \"method\": \"tools/call\",
    \"params\": { \"name\": \"$2\", \"arguments\": $3 }
  }"
}

check_call_ok() { # $1 = label, $2 = response, $3 = expected substring
  if echo "$2" | grep -q '"isError":true'; then
    fail "$1" "tool returned isError: $(echo "$2" | head -c 300)"
  elif echo "$2" | grep -qF "$3"; then
    pass "$1"
  else
    fail "$1" "missing '$3' in: $(echo "$2" | head -c 300)"
  fi
}

echo ""
echo "--- Tool: convert_currency (USD->CAD, no date) ---"
R=$(call_tool 10 convert_currency '{"amount":100,"from":"USD","to":"CAD"}')
echo "     ${R:0:260}"
check_call_ok "convert_currency returns real number" "$R" "converted_amount"
if echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sc = d['result']['structuredContent']
assert isinstance(sc['converted_amount'], (int, float)) and sc['converted_amount'] > 100, sc
assert sc['source'].startswith('Bank of Canada'), sc
print('     rate:', sc['rate'], '| converted:', sc['converted_amount'], '| rate_date:', sc['rate_date'])
" 2>/dev/null; then
  pass "convert_currency structuredContent is numeric and sourced"
else
  fail "convert_currency structuredContent" "check output above"
fi

echo ""
echo "--- Tool: convert_currency (weekend date -> prior business day) ---"
R=$(call_tool 11 convert_currency '{"amount":100,"from":"USD","to":"CAD","date":"2026-10-04"}')
echo "     ${R:0:260}"
if echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sc = d['result']['structuredContent']
assert sc['requested_date'] == '2026-10-04' and sc['rate_date'] < '2026-10-04', sc
assert 'note' in sc, sc
print('     requested:', sc['requested_date'], '-> rate_date:', sc['rate_date'])
" 2>/dev/null; then
  pass "weekend date resolves to prior business day with note"
else
  fail "weekend date handling" "check output above"
fi

echo ""
echo "--- Tool: convert_currency (invalid code -> graceful error) ---"
R=$(call_tool 12 convert_currency '{"amount":100,"from":"XXX","to":"CAD"}')
echo "     ${R:0:260}"
if echo "$R" | grep -q '"isError":true' && echo "$R" | grep -q "Unsupported currency code"; then
  pass "invalid currency code returns graceful isError"
else
  fail "invalid currency code" "expected graceful error"
fi

echo ""
echo "--- Tool: fx_history ---"
R=$(call_tool 13 fx_history '{"from":"USD","to":"EUR","start_date":"2026-09-28","end_date":"2026-10-02"}')
echo "     ${R:0:260}"
check_call_ok "fx_history returns series" "$R" '"series"'
if echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sc = d['result']['structuredContent']
assert sc['count'] == len(sc['series']) > 0, sc
assert all(p['date'] >= '2026-09-28' and p['date'] <= '2026-10-02' for p in sc['series']), sc
print('     points:', sc['count'], '| first:', sc['series'][0], '| last:', sc['series'][-1])
" 2>/dev/null; then
  pass "fx_history series parsed and in range"
else
  fail "fx_history series" "check output above"
fi

echo ""
echo "--- Tool: latest_rates ---"
R=$(call_tool 14 latest_rates '{}')
echo "     ${R:0:260}"
if echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sc = d['result']['structuredContent']
assert sc['base'] == 'CAD', sc
assert sc['count'] >= 20, sc
assert isinstance(sc['rates']['USD'], (int, float)) and 1.0 < sc['rates']['USD'] < 2.0, sc['rates']['USD']
print('     date:', sc['date'], '| count:', sc['count'], '| USD:', sc['rates']['USD'], '| cached:', sc['cached'])
" 2>/dev/null; then
  pass "latest_rates returns sane CAD-based rates"
else
  fail "latest_rates" "check output above"
fi

# Summary
echo ""
echo "================================"
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
[ "$FAILED" -gt 0 ] && exit 1
