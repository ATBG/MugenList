#!/bin/bash
# MugelList API Server Startup Script
# This script starts the Python backend API server for the Play feature

echo "Starting MugelList API Server..."
echo "The API server handles local file operations and online stream resolution."
echo ""
echo "API Server will run on http://localhost:8765"
echo "Press Ctrl+C to stop the server."
echo ""

python3 api/index.py
