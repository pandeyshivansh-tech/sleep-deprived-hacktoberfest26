#!/usr/bin/env bash
# Runs both invalid archives through the CLI and through the API, printing exactly
# what each returns. The API part needs the server running (npm run dev:server).
# Nothing here executes package code; the files are inert text.
set -u
cd "$(dirname "$0")/../.."
API="${AUDYSSEY_API:-http://127.0.0.1:8787}"

for file in not-a-gzip gzip-not-tar; do
  echo "=== CLI: node server/bin/audyssey.js analyze --tarball examples/invalid-demo/$file.tgz"
  node server/bin/audyssey.js analyze --tarball "examples/invalid-demo/$file.tgz" 2>&1 >/dev/null
  echo "exit code: $?"
  echo
  echo "=== API: POST /api/analyze  ($file.tgz)"
  response=$(curl -s -w '\nHTTP %{http_code}' -X POST -H 'Content-Type: application/gzip' --data-binary "@examples/invalid-demo/$file.tgz" "$API/api/analyze?filename=$file.tgz")
  echo "$response" | sed -E 's/"id":"[0-9a-f]{32}"/"id":"<job id>"/; s/"(createdAt|updatedAt|at)":"[^"]*"/"\1":"<time>"/g'
  id=$(echo "$response" | sed -n 's/.*"id":"\([0-9a-f]\{32\}\)".*/\1/p' | head -1)
  if [ -n "$id" ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      state=$(curl -s "$API/api/jobs/$id")
      case "$state" in *'"state":"failed"'*|*'"state":"completed"'*) break ;; esac
      sleep 1
    done
    echo "=== API: GET /api/jobs/<job id>"
    echo "$state" | sed -E 's/"id":"[0-9a-f]{32}"/"id":"<job id>"/; s/"(createdAt|updatedAt|at)":"[^"]*"/"\1":"<time>"/g'
    echo "=== API: GET /api/jobs/<job id>/report"
    curl -s -w '\nHTTP %{http_code}\n' "$API/api/jobs/$id/report"
  fi
  echo
done
