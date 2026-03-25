#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  SEO Intel — Setup Wizard"
echo "  Opening setup in your browser..."
echo ""
node cli.js serve &
SERVER_PID=$!
# Wait for server to be ready
for i in {1..10}; do
  sleep 1
  if curl -s http://localhost:3000/ > /dev/null 2>&1; then break; fi
done
open "http://localhost:3000/setup"
wait $SERVER_PID
