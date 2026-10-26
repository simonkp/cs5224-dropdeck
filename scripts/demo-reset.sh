#!/usr/bin/env bash
# Reset a stage to fresh demo data and print the links to test with. Run it before every demo or test session.
#
# Usage: pnpm demo:reset -- <stage> [owner-email] [--opens-in N]
#   pnpm demo:reset -- dev-simon
#   pnpm demo:reset -- dev-simon you@example.com --opens-in 5
#
# - Signs you in to AWS first if your session has expired (prints a link and a code to enter in the browser).
# - owner-email is the console login the demo shop belongs to. Left out, it uses the stage's only console user,
#   or lists them if there are several.
# - Wipes the stage's drops, orders, shop pages and uploads, then loads three demo shops (scripts/../eval/seed.ts).
# - Stages that are not dev-* are only wiped with FORCE=1, e.g. FORCE=1 pnpm demo:reset -- staging you@example.com
# - AWS profile: $AWS_PROFILE, default dropdeck-uni.
set -euo pipefail

[ "${1:-}" = "--" ] && shift # pnpm passes its own -- through
stage="${1:-}"
[ -n "$stage" ] || { sed -n '4,6p' "$0" | sed 's/^# //'; exit 1; }
shift
owner=""
if [ $# -gt 0 ] && [[ "$1" != --* ]]; then owner="$1"; shift; fi
extra=("$@")

export AWS_PROFILE="${AWS_PROFILE:-dropdeck-uni}"
export AWS_REGION="${AWS_REGION:-ap-southeast-1}"

# 1. AWS sign-in
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS session for profile '$AWS_PROFILE' has expired. Open the link below and enter the code to sign in:"
  aws sso login --use-device-code --no-browser
  aws sts get-caller-identity >/dev/null || { echo "Still not signed in to AWS; stopping." >&2; exit 1; }
fi
account="$(aws sts get-caller-identity --query Account --output text)"
echo "AWS account $account, profile $AWS_PROFILE, stage $stage"

# 2. Owner: the console login the demo shop belongs to
pool="$(aws cloudformation describe-stacks --stack-name "DropDeck-$stage" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text 2>/dev/null || true)"
[ -n "$pool" ] && [ "$pool" != "None" ] || { echo "No stack DropDeck-$stage in account $account. Deploy it first." >&2; exit 1; }
if [ -z "$owner" ]; then
  # A read loop, not mapfile: macOS ships bash 3.2, which has no mapfile.
  emails=()
  while IFS= read -r line; do emails+=("$line"); done < <(aws cognito-idp list-users --user-pool-id "$pool" \
    --query "Users[].Attributes[?Name=='email'].Value" --output text | tr '\t' '\n' | sed '/^$/d')
  site="$(aws cloudformation describe-stacks --stack-name "DropDeck-$stage" --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)"
  if [ "${#emails[@]}" -eq 1 ]; then
    owner="${emails[0]}"
  elif [ "${#emails[@]}" -eq 0 ]; then
    echo "No console users on $stage yet. Sign up at $site/m/ first, then run this again." >&2; exit 1
  else
    echo "Several console users on $stage; pass the one to own the demo shop:" >&2
    printf '  %s\n' "${emails[@]}" >&2; exit 1
  fi
fi

# 3. Wipe and seed (the seed prints the demo links at the end)
force=()
if [[ "$stage" != dev* ]]; then
  [ "${FORCE:-}" = 1 ] || { echo "Refusing to wipe $stage: it is not a dev stage. Re-run with FORCE=1 if you mean it." >&2; exit 1; }
  force=(--force)
fi
cd "$(dirname "$0")/.."
# ${a[@]+"${a[@]}"}: bash 3.2 treats an empty array as unset under set -u.
pnpm --silent seed -- --stage "$stage" --owner "$owner" --clear ${force[@]+"${force[@]}"} ${extra[@]+"${extra[@]}"}
