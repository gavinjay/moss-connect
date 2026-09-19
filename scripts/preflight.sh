#!/usr/bin/env bash
# Pre-deploy credential check.
#
# Runs in about a second, BEFORE cdk spends time bundling three Lambdas only to
# fail on credentials. It answers the two questions that have actually gone wrong
# here: which account am I pointed at, and do I have a profile for it?
#
# Deliberately prints no placeholder values. It discovers your real profile names
# and the account each one resolves to, so there is nothing to hand-substitute.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET_ARN=$(node -e "
  const c = require('$ROOT/cdk.json');
  process.stdout.write(c.context.mossConnect.connect.existingInstanceArn || '');
" 2>/dev/null)

if [ -z "$TARGET_ARN" ]; then
  echo "preflight: cdk.json has no connect.existingInstanceArn; skipping account check."
  exit 0
fi

TARGET_ACCOUNT=$(printf '%s' "$TARGET_ARN" | cut -d: -f5)
TARGET_REGION=$(printf '%s' "$TARGET_ARN" | cut -d: -f4)

echo "preflight: this project targets account $TARGET_ACCOUNT in $TARGET_REGION"

if ! command -v aws >/dev/null 2>&1; then
  echo "preflight: aws CLI not found; cannot verify credentials. Continuing."
  exit 0
fi

CURRENT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)

if [ "$CURRENT" = "$TARGET_ACCOUNT" ]; then
  echo "preflight: OK -- current credentials are for $CURRENT"
  exit 0
fi

if [ -z "$CURRENT" ]; then
  echo "preflight: FAIL -- no working credentials are currently configured."
else
  echo "preflight: FAIL -- current credentials are for $CURRENT, not $TARGET_ACCOUNT."
fi

echo
echo "Your configured profiles, and the account each one resolves to:"
echo
FOUND=""
while IFS= read -r p; do
  [ -z "$p" ] && continue
  acct=$(aws sts get-caller-identity --profile "$p" --query Account --output text 2>/dev/null || echo "-")
  if [ "$acct" = "$TARGET_ACCOUNT" ]; then
    printf '  %-14s %s   <-- use this one\n' "$acct" "$p"
    FOUND="$p"
  else
    printf '  %-14s %s\n' "$acct" "$p"
  fi
done < <(aws configure list-profiles 2>/dev/null)

echo
if [ -n "$FOUND" ]; then
  echo "Run:  export AWS_PROFILE=$FOUND"
else
  echo "None of your profiles resolve to $TARGET_ACCOUNT."
  echo "You created the Connect instance in that account, but this machine has no"
  echo "credentials for it. Options: add a profile for it (aws configure sso, or"
  echo "aws configure --profile <name>), assume a role into it, or move the Connect"
  echo "instance to an account you do have access to."
fi
exit 1
