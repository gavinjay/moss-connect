#!/usr/bin/env bash
# Did this project leave anything behind in any AWS account?
#
# Checks every configured profile for resources this project would create.
# Read-only: it lists, it never deletes. Deleting is your call, with the
# resource in front of you.
set -uo pipefail

REGIONS="us-west-2 us-east-1 us-east-2"
STACKS="ConnectFoundationStack MossConnectStack"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found."; exit 1
fi

echo "Auditing every configured profile for moss-connect resources."
echo "Read-only. Nothing is deleted."
echo

FOUND_ANY=""
while IFS= read -r p; do
  [ -z "$p" ] && continue
  acct=$(aws sts get-caller-identity --profile "$p" --query Account --output text 2>/dev/null || echo "")
  if [ -z "$acct" ]; then
    printf '%-18s (no working credentials, skipped)\n' "$p"
    continue
  fi
  printf '%-18s account %s\n' "$p" "$acct"

  for r in $REGIONS; do
    for s in $STACKS; do
      status=$(aws cloudformation describe-stacks --profile "$p" --region "$r" \
        --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)
      if [ -n "$status" ] && [ "$status" != "None" ]; then
        printf '    FOUND  %s/%s  %s = %s\n' "$acct" "$r" "$s" "$status"
        FOUND_ANY="yes"
      fi
    done

    # A claimed phone number bills monthly whether or not a stack still exists.
    nums=$(aws connect list-phone-numbers-v2 --profile "$p" --region "$r" \
      --query "ListPhoneNumbersSummaryList[?contains(PhoneNumberDescription, 'moss-connect')].PhoneNumber" \
      --output text 2>/dev/null || true)
    if [ -n "$nums" ] && [ "$nums" != "None" ]; then
      printf '    FOUND  %s/%s  claimed phone number(s): %s\n' "$acct" "$r" "$nums"
      FOUND_ANY="yes"
    fi
  done
done < <(aws configure list-profiles 2>/dev/null)

echo
if [ -n "$FOUND_ANY" ]; then
  echo "Resources found above. To remove a stack:"
  echo "  AWS_PROFILE=<the profile shown> npx cdk destroy --all"
  echo "Release a phone number from the Connect console -- it bills monthly until you do."
else
  echo "Clean: no moss-connect stacks or phone numbers in any configured profile."
fi
