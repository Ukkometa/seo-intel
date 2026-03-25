#!/bin/bash
# Double-click this file to launch SEO Intel dashboard
cd "$(dirname "$0")"
echo ""
echo "  Starting SEO Intel..."
echo "  Dashboard will open in your browser."
echo ""
node cli.js serve --open
