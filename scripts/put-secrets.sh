#!/usr/bin/env bash
# Creates the per-stage signing keys as SecureString parameters (CloudFormation cannot create SecureStrings).
# Usage: scripts/put-secrets.sh <stage>
set -euo pipefail
stage="${1:?stage}"
for name in token-key email-hash-key; do
  aws ssm put-parameter --name "/dropdeck/${stage}/${name}" --type SecureString \
    --value "$(openssl rand -base64 48)" --overwrite >/dev/null
  echo "wrote /dropdeck/${stage}/${name}"
done
