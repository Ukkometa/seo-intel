#!/bin/bash
# Double-click this file to launch SEO Intel dashboard
cd "$(dirname "$0")"
echo ""
echo "  Starting SEO Intel..."
echo "  Dashboard will open in your browser."
echo ""

# Kill any stale server on the same port so new code is always loaded
PORT="${SEO_INTEL_PORT:-3000}"
OLD_PID=$(lsof -ti :"$PORT" 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "  Restarting server (killing stale PID $OLD_PID on port $PORT)..."
  kill "$OLD_PID" 2>/dev/null
  sleep 1
fi

node cli.js serve --open
