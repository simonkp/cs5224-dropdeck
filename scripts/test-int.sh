#!/usr/bin/env bash
# Integration tests: real handlers in-process against DynamoDB Local (Docker).
# Usage: scripts/test-int.sh   (DDB_PORT defaults to 8765; reuses a running dropdeck-ddb container)
set -euo pipefail
port="${DDB_PORT:-8765}"
started=""
if ! docker ps --format '{{.Names}}' | grep -qx dropdeck-ddb; then
  docker run -d --rm -p "127.0.0.1:${port}:8000" --name dropdeck-ddb amazon/dynamodb-local \
    -jar DynamoDBLocal.jar -inMemory -sharedDb >/dev/null
  started=1
  for _ in $(seq 1 30); do curl -s -o /dev/null "http://localhost:${port}" && break; sleep 0.5; done
fi
trap '[ -n "$started" ] && docker stop dropdeck-ddb >/dev/null' EXIT
DYNAMODB_LOCAL="http://localhost:${port}" pnpm --filter @dropdeck/integration-tests test
