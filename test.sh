#!/usr/bin/env bash

set -e

cd backend
echo "🧪 Running backend tests..."
npm test

echo "==============================="

cd ../frontend
echo "🧪 Running frontend tests..."
npm test
