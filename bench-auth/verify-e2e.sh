#!/usr/bin/env bash
#
# bench-auth end-to-end verification.
#
# Proves, against the deployed stacks with a real Google sign-in and real
# STS credentials, that:
#
#   1. the hosted UI + Google IdP complete an authorization-code flow
#   2. the Identity Pool exchanges that id_token for credentials
#   3. those credentials are the authenticated role and nothing wider
#   4. those credentials CANNOT reach Bedrock -- the load-bearing constraint
#      in CLAUDE.md, "the Lambda stays the only thing that calls Bedrock"
#   5. the Function URL's auth posture matches the phase the repo is in
#
# Step 5 is phase-aware and needs no editing at cutover. It reads the live
# AuthType off the Function URL and asserts what that phase requires:
#
#   AuthType: NONE      (Phase 1) unsigned call succeeds, signed call denied
#   AuthType: AWS_IAM   (Phase 2) unsigned call 403s, signed call authenticates
#
# The Phase 2 expectations are the two checks CLAUDE.md names as part of the
# cutover, so run this immediately after that deploy.
#
# SIDE EFFECT: completing the sign-in creates a real Cognito user (yours) in
# the pool, and under AuthType NONE the unsigned probe is a real invocation
# that costs a real Bedrock call. Everything else is read-only. No deploy, no
# resource mutation, no sam.
#
# Every id is resolved from stack outputs at run time. Nothing here is
# hardcoded to one account, and no account id lives in this file.
#
# Usage:  bash bench-auth/verify-e2e.sh
# Env overrides: STACK_NAME, EXTRACT_STACK, FUNCTION_NAME, AWS_REGION

set -uo pipefail

STACK_NAME=${STACK_NAME:-bench-auth}
EXTRACT_STACK=${EXTRACT_STACK:-sam-app}
FUNCTION_NAME=${FUNCTION_NAME:-bench-extract}
REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo ap-southeast-2)}}

pass=0; fail=0; skip=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
meh()  { echo "  SKIP  $*"; skip=$((skip+1)); }
note() { echo "  note  $*"; }
step() { echo; echo "=== $* ==="; }

need() { command -v "$1" >/dev/null || { echo "missing required tool: $1"; exit 1; }; }
need aws; need curl; need python3; need openssl

step "0. resolve the deployed stack"
OUTPUTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs' --output json 2>&1) || { echo "$OUTPUTS"; exit 1; }
out() { printf '%s' "$OUTPUTS" | python3 -c \
  'import sys,json; k=sys.argv[1]; print(next((o["OutputValue"] for o in json.load(sys.stdin) if o["OutputKey"]==k), ""))' "$1"; }

POOL_ID=$(out UserPoolId)
CLIENT_ID=$(out UserPoolClientId)
IDENTITY_POOL=$(out IdentityPoolId)
DOMAIN=$(out HostedUiDomain)
ROLE_ARN=$(out AuthenticatedRoleArn)
ROLE_NAME=${ROLE_ARN##*/}
for v in POOL_ID CLIENT_ID IDENTITY_POOL DOMAIN ROLE_ARN; do
  [ -n "${!v}" ] || { echo "stack output missing: $v"; exit 1; }
done
echo "    user pool     $POOL_ID"
echo "    client        $CLIENT_ID"
echo "    identity pool $IDENTITY_POOL"
echo "    role          $ROLE_NAME"

# The redirect must be one the client already allows, or Cognito rejects the
# authorize request. Prefer a localhost callback: the browser lands on a dead
# port and the code stays in the address bar instead of being consumed by the
# real site.
CALLBACKS=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --region "$REGION" \
  --query 'UserPoolClient.CallbackURLs' --output json 2>/dev/null | python3 -c \
  'import sys,json; [print(x) for x in json.load(sys.stdin)]')
[ -n "$CALLBACKS" ] || { echo "client has no callback URLs"; exit 1; }

# Among the localhost callbacks, prefer a port nothing is listening on. If the
# vue dev server happens to be up on its port, it will answer the redirect and
# consume the code before you can copy it out of the address bar.
REDIRECT=""; FALLBACK=""
while read -r u; do
  case "$u" in *localhost*) ;; *) continue ;; esac
  [ -n "$FALLBACK" ] || FALLBACK=$u
  port=${u##*:}; port=${port%%/*}
  if ! timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    REDIRECT=$u; break
  fi
done <<<"$CALLBACKS"
REDIRECT=${REDIRECT:-${FALLBACK:-$(printf '%s' "$CALLBACKS" | head -1)}}
echo "    redirect      $REDIRECT"
if [ -n "$FALLBACK" ] && [ "$REDIRECT" = "$FALLBACK" ]; then
  port=${REDIRECT##*:}; port=${port%%/*}
  if timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    note "something is listening on $port; stop it or the code may be consumed on redirect"
  fi
fi

# shellcheck disable=SC2016  # backticks here are JMESPath literal-quoting, not a subshell
MODEL_ID=$(aws cloudformation describe-stacks --stack-name "$EXTRACT_STACK" --region "$REGION" \
  --query 'Stacks[0].Parameters[?ParameterKey==`BedrockModelId`].ParameterValue' --output text 2>/dev/null)
MODEL_ID=${MODEL_ID:-anthropic.claude-haiku-4-5-20251001-v1:0}

FURL_JSON=$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$REGION" --output json 2>/dev/null)
FURL=$(printf '%s' "$FURL_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("FunctionUrl",""))' 2>/dev/null)
FURL_AUTH=$(printf '%s' "$FURL_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("AuthType",""))' 2>/dev/null)
echo "    function url  ${FURL_AUTH:-unknown} ${FURL:-(not found)}"

echo "  users in $POOL_ID before this run:"
aws cognito-idp list-users --user-pool-id "$POOL_ID" --region "$REGION" \
  --query 'Users[].Username' --output text | sed 's/^/    /'

step "1. authorization-code flow (PKCE)"
VERIFIER=$(openssl rand -base64 60 | tr -d '\n=+/' | cut -c1-64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -binary -sha256 | openssl base64 | tr -d '\n=' | tr '+/' '-_')
REDIRECT_ENC=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$REDIRECT")
AUTH_URL="$DOMAIN/oauth2/authorize?client_id=$CLIENT_ID&response_type=code&scope=email+openid+profile&redirect_uri=$REDIRECT_ENC&identity_provider=Google&code_challenge_method=S256&code_challenge=$CHALLENGE"

cat <<EOF

Open this URL in a browser and sign in with Google:

$AUTH_URL

You will be redirected to $REDIRECT/?code=...  The page will fail to load if
nothing is serving that port. That is expected. Copy the value of ?code= out
of the address bar.

The code is single-use and expires in about 5 minutes.
EOF

read -rp $'\nPaste the ?code= value: ' CODE
[ -n "${CODE:-}" ] || { bad "no code entered"; exit 1; }

TOKEN_JSON=$(curl -sS -X POST "$DOMAIN/oauth2/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=$REDIRECT" \
  --data-urlencode "code_verifier=$VERIFIER")

ID_TOKEN=$(printf '%s' "$TOKEN_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id_token",""))' 2>/dev/null)
if [ -z "$ID_TOKEN" ]; then
  bad "token exchange returned no id_token"
  echo "  response: $TOKEN_JSON"
  exit 1
fi
ok "token exchange returned an id_token"

# Pass the token as argv, not on stdin: a `python3 - <<EOF` heredoc IS stdin,
# so a piped token is silently discarded and the decode reads an empty string.
python3 -c '
import sys, json, base64
t = sys.argv[1].split(".")[1]
c = json.loads(base64.urlsafe_b64decode(t + "=" * (-len(t) % 4)))
for k in ("iss", "aud", "email", "cognito:username"):
    if k in c:
        print("    %s: %s" % (k, c[k]))
' "$ID_TOKEN"

step "2. Identity Pool exchange"
LOGINS=$(python3 -c "import json,sys; print(json.dumps({'cognito-idp.$REGION.amazonaws.com/$POOL_ID': sys.argv[1]}))" "$ID_TOKEN")

IDENTITY_ID=$(aws cognito-identity get-id \
  --identity-pool-id "$IDENTITY_POOL" --region "$REGION" \
  --logins "$LOGINS" --query IdentityId --output text 2>&1)
case "$IDENTITY_ID" in
  "$REGION":*) ok "get-id returned identity $IDENTITY_ID" ;;
  *) bad "get-id failed: $IDENTITY_ID"; exit 1 ;;
esac

CREDS=$(aws cognito-identity get-credentials-for-identity \
  --identity-id "$IDENTITY_ID" --region "$REGION" \
  --logins "$LOGINS" --output json 2>&1)
AK=$(printf '%s' "$CREDS" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Credentials"]["AccessKeyId"])' 2>/dev/null)
if [ -z "$AK" ]; then bad "get-credentials-for-identity failed: $CREDS"; exit 1; fi
SK=$(printf '%s' "$CREDS" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Credentials"]["SecretKey"])')
ST=$(printf '%s' "$CREDS" | python3 -c 'import sys,json; print(json.load(sys.stdin)["Credentials"]["SessionToken"])')
ok "received temporary credentials (${AK:0:8}...)"

# From here on, run as the Cognito user only. Scrubbing AWS_PROFILE matters:
# without it a deny that silently fell back to your admin identity would read
# as a pass, which is the exact failure this script exists to rule out.
run_as_user() {
  env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
      AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" \
      "$@"
}

step "3. identity of those credentials"
ARN=$(run_as_user aws sts get-caller-identity --query Arn --output text 2>&1)
echo "    $ARN"
case "$ARN" in
  *"$ROLE_NAME"*) ok "credentials are the bench-auth authenticated role" ;;
  *) bad "unexpected principal: $ARN" ;;
esac

step "4. Bedrock must be denied"
# AWS CLI v2 wants --body base64 unless told otherwise. Without the binary
# format flag the CLI errors client-side, nothing reaches Bedrock, and the
# check passes vacuously while proving nothing.
OUT=$(run_as_user aws bedrock-runtime invoke-model \
  --region "$REGION" --model-id "$MODEL_ID" \
  --content-type application/json \
  --cli-binary-format raw-in-base64-out \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
  /dev/stdout 2>&1)
case "$OUT" in
  *AccessDenied*|*"not authorized"*) ok "bedrock:InvokeModel denied" ;;
  *"Invalid base64"*|*"Parameter validation"*) bad "InvokeModel never left the machine: $OUT" ;;
  *) bad "InvokeModel was NOT denied: $OUT" ;;
esac

OUT=$(run_as_user aws bedrock list-foundation-models --region "$REGION" 2>&1)
case "$OUT" in
  *AccessDenied*|*"not authorized"*) ok "bedrock:ListFoundationModels denied" ;;
  *) bad "ListFoundationModels was NOT denied: $OUT" ;;
esac

OUT=$(run_as_user aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" 2>&1)
case "$OUT" in
  *AccessDenied*|*"not authorized"*) ok "no lambda:GetFunction (role is not over-broad)" ;;
  *) bad "role can read the Lambda config; grant is wider than documented" ;;
esac

step "5. Function URL posture (AuthType: ${FURL_AUTH:-unknown})"
if [ -z "$FURL" ]; then
  meh "no Function URL on $FUNCTION_NAME; skipping"
else
  UNSIGNED=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FURL" \
    -H 'Content-Type: application/json' --data '{}' --max-time 30)
  SIGNED=$(AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" \
    FURL="$FURL" REGION="$REGION" python3 - <<'PYSIGN'
import datetime, hashlib, hmac, json, os, urllib.parse, urllib.request, urllib.error

url = os.environ["FURL"]; region = os.environ["REGION"]
ak, sk, st = os.environ["AWS_ACCESS_KEY_ID"], os.environ["AWS_SECRET_ACCESS_KEY"], os.environ["AWS_SESSION_TOKEN"]
p = urllib.parse.urlparse(url)
host, path, service = p.netloc, p.path or "/", "lambda"
body = b"{}"
now = datetime.datetime.now(datetime.timezone.utc)
amzdate, datestamp = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
payload_hash = hashlib.sha256(body).hexdigest()

headers = {"content-type": "application/json", "host": host,
           "x-amz-content-sha256": payload_hash, "x-amz-date": amzdate,
           "x-amz-security-token": st}
signed = ";".join(sorted(headers))
canon_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
canon = f"POST\n{path}\n\n{canon_headers}\n{signed}\n{payload_hash}"
scope = f"{datestamp}/{region}/{service}/aws4_request"
sts_ = f"AWS4-HMAC-SHA256\n{amzdate}\n{scope}\n{hashlib.sha256(canon.encode()).hexdigest()}"

def sign(k, m): return hmac.new(k, m.encode(), hashlib.sha256).digest()
k = sign(sign(sign(sign(("AWS4" + sk).encode(), datestamp), region), service), "aws4_request")
sig = hmac.new(k, sts_.encode(), hashlib.sha256).hexdigest()
headers["authorization"] = (f"AWS4-HMAC-SHA256 Credential={ak}/{scope}, "
                            f"SignedHeaders={signed}, Signature={sig}")
req = urllib.request.Request(url, data=body, headers=headers, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception as e:
    print(f"error:{e}")
PYSIGN
)
  echo "    unsigned POST -> $UNSIGNED     signed POST -> $SIGNED"

  case "$FURL_AUTH" in
    NONE)
      # Phase 1. The URL is public, and the role's grant is conditioned on
      # AuthType being AWS_IAM, so the signed call is expected to be refused.
      # Neither result is a defect before the cutover.
      if [ "$UNSIGNED" != "403" ]; then
        ok "unsigned call reaches the function (public, pre-cutover)"
      else
        bad "unsigned call 403d but AuthType is NONE"
      fi
      if [ "$SIGNED" = "403" ]; then
        ok "signed call denied: grant requires AuthType AWS_IAM (expected pre-cutover)"
      else
        note "signed call returned $SIGNED; under AuthType NONE the URL ignores SigV4"
      fi
      note "Phase 1 posture. After the Phase 2 deploy, re-run: these two flip."
      ;;
    AWS_IAM)
      # Phase 2. Both of these are the cutover gates named in CLAUDE.md.
      if [ "$UNSIGNED" = "403" ]; then
        ok "unsigned call returns 403 (cutover gate)"
      else
        bad "unsigned call returned $UNSIGNED, expected 403"
      fi
      if [ "$SIGNED" != "403" ]; then
        ok "signed call authenticates (HTTP $SIGNED)"
      else
        bad "signed call was denied; the authenticated role cannot reach the function"
      fi
      ;;
    *)
      meh "unrecognised AuthType '$FURL_AUTH'"
      ;;
  esac
fi

step "6. users after this run"
aws cognito-idp list-users --user-pool-id "$POOL_ID" --region "$REGION" \
  --query 'Users[].[Username,UserStatus,UserCreateDate]' --output text | sed 's/^/    /'

echo
echo "=================================="
echo " passed: $pass   failed: $fail   skipped: $skip"
echo "=================================="
[ "$fail" -eq 0 ]
