#!/bin/bash

# API Testing Script for Holmdale Rodeo Backend
# Usage: ./test-api.sh [BASE_URL]
# Example: ./test-api.sh http://localhost:3000

BASE_URL=${1:-http://localhost:3000}
echo "🧪 Testing API at: $BASE_URL"
echo "================================"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test function
test_endpoint() {
  local method=$1
  local endpoint=$2
  local description=$3
  local data=$4
  
  echo -n "Testing $description... "
  
  if [ -z "$data" ]; then
    response=$(curl -s -o /dev/null -w "%{http_code}" -X $method "$BASE_URL$endpoint")
  else
    response=$(curl -s -o /dev/null -w "%{http_code}" -X $method "$BASE_URL$endpoint" \
      -H "Content-Type: application/json" \
      -d "$data")
  fi
  
  if [ $response -eq 200 ] || [ $response -eq 201 ]; then
    echo -e "${GREEN}✓ PASS${NC} ($response)"
  else
    echo -e "${RED}✗ FAIL${NC} ($response)"
  fi
}

# Health check
test_endpoint "GET" "/health" "Health Check"

# Public endpoints
test_endpoint "GET" "/api/events" "Get Events (Public)"
test_endpoint "GET" "/api/products" "Get Products (Public)"

# Auth endpoints
test_endpoint "POST" "/api/auth/login" "Login Endpoint" \
  '{"email":"darren@holmgraphics.ca","password":"changeme123"}'

# Get token for authenticated tests
echo ""
echo "🔐 Getting auth token..."
TOKEN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"darren@holmgraphics.ca","password":"changeme123"}' \
  | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -n "$TOKEN" ]; then
  echo -e "${GREEN}✓ Token obtained${NC}"
  
  # Authenticated endpoints
  echo ""
  echo "🔒 Testing authenticated endpoints..."
  
  echo -n "Testing Get Staff... "
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE_URL/api/staff")
  
  if [ $response -eq 200 ]; then
    echo -e "${GREEN}✓ PASS${NC} ($response)"
  else
    echo -e "${RED}✗ FAIL${NC} ($response)"
  fi
  
  echo -n "Testing Get Shifts... "
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE_URL/api/shifts")
  
  if [ $response -eq 200 ]; then
    echo -e "${GREEN}✓ PASS${NC} ($response)"
  else
    echo -e "${RED}✗ FAIL${NC} ($response)"
  fi
  
  echo -n "Testing Dashboard... "
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE_URL/api/dashboard/stats")
  
  if [ $response -eq 200 ]; then
    echo -e "${GREEN}✓ PASS${NC} ($response)"
  else
    echo -e "${RED}✗ FAIL${NC} ($response)"
  fi
else
  echo -e "${RED}✗ Failed to get token - cannot test authenticated endpoints${NC}"
  echo "Make sure you've run migrations: npm run migrate"
fi

echo ""
echo "================================"
echo "✅ API testing complete!"
echo ""
echo "Full API docs: $BASE_URL/"
