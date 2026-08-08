# bench-extract

Backend for Bench's "+ Add listing" flow. One Lambda behind a Function URL
(no API Gateway, no VPC). Given a pasted Domain/realestate.com.au URL or raw
listing text, it fetches/reads the text server-side and asks Claude Haiku
(via Amazon Bedrock) for structured listing facts as JSON.

`index.mjs` is the request/response contract. Keep it byte-for-byte in sync
with `src/components/bench/AddListingFlow.vue`.

**This file is the procedure: how to deploy it and what to do when a circuit
breaker fires.** The reasoning behind every guardrail, the threat model and the
known gaps live in [`SECURITY.md`](../../SECURITY.md) at the repo root. Read
that before changing a guardrail; read this before deploying one.

## Why Bedrock, not the direct Anthropic API

IAM auth (`bedrock:InvokeModel` on the execution role) means no static
Anthropic API key to leak or rotate. Billing lands in the same AWS account,
so one Budget alert covers both. Only dependency: the official
`@aws-sdk/client-bedrock-runtime`.

## What bounds spend

Four layers, fastest to slowest. Layer 1 is account-level and not in this
template; the rest are. See SECURITY.md for why each is shaped this way.

1. **Bedrock Service Quota**, enforced synchronously on every `InvokeModel`
   call and the only layer with no lag.
2. **`ReservedConcurrentExecutions: 1`**, which bounds the _rate_ of spend,
   never the total.
3. **CloudWatch alarm → kill switch** (~1-6 min): >100 invocations in 5 minutes
   fires `BenchHighInvocationAlarm`, which notifies an SNS topic that invokes
   `bench-extract-kill-switch`, setting reserved concurrency to **0**.
4. **Budget + BudgetsAction** (6-24 h lag): at `BudgetMonthlyLimitUsd`, AWS
   attaches a deny-`bedrock:InvokeModel` policy to the execution role.

Plus an email-only budget at `EarlyWarningBudgetUsd` (default $1) that stops
nothing and exists so the first news of creeping spend is not a breaker
tripping.

## First deploy

Requires the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
and AWS credentials.

### By-hand prerequisites

Nothing in `template.yaml` can do these for you, and they are invisible to code
review. Do them first, per account and per region.

- **Enable Bedrock model access for Claude Haiku only** (Bedrock console →
  Model access) in `ap-southeast-2`. Keep it to Haiku: a blanket enable removes
  a whole layer, and Opus-tier pricing is roughly an order of magnitude above
  Haiku's.

  You do **not** also need it in `ap-southeast-4`, the profile's other routing
  target. Melbourne is an opt-in region and is currently disabled on this
  account, and the `au.` profile still resolves and serves from Sydney
  regardless (verified 2026-08-08 with a live Converse call). Practically the
  profile is Sydney-only today, so it buys the AU data-residency guarantee but
  not the extra burst capacity cross-region inference normally gives you. If
  you ever opt into Melbourne (`aws account get-region-opt-status
  --region-name ap-southeast-4` to check), enable Haiku access there too and
  the second region starts carrying load. The IAM policy already grants it, so
  nothing in the template needs to change.
- **Confirm the inference profile and its routing targets:**
  ```bash
  aws bedrock get-inference-profile --region ap-southeast-2 \
    --inference-profile-identifier au.anthropic.claude-haiku-4-5-20251001-v1:0
  ```
  The `models[].modelArn` values it returns are exactly the foundation-model
  ARNs the IAM policy grants; if that list ever changes, the policy needs the
  same edit. `BedrockRegion` must stay inside the profile's geography
  (`ap-southeast-2` or `ap-southeast-4`) — unlike a bare foundation-model ID,
  it can't be repointed at `us-east-1` to chase availability.
- **Lower the Bedrock on-demand rate quota** to roughly 1-2x realistic personal
  usage. Do this early, not during an incident: the Service Quotas console form
  is built for _increases_, and a decrease generally needs a support case.
- **Generate the access token:** `openssl rand -hex 24`. It is `NoEcho: true`
  so it never appears in stack logs.

### Deploy

```bash
cd lambda/bench-extract
sam build
sam deploy --guided
```

Guided mode prompts for `BenchAccessToken`, `BedrockModelId`,
`BedrockFoundationModelId`, `BedrockRegion`, `BudgetMonthlyLimitUsd`,
`EarlyWarningBudgetUsd` and `AlertEmail`. The two model parameters are the same
string with and without the `au.` prefix: the profile the request names, and the
underlying model IAM has to authorize it against. Change one, change both.

Two prompts are worth knowing about in advance:

- **`Allow SAM CLI IAM role creation [Y/n]`**, answer `Y`. This is the
  `CAPABILITY_IAM` acknowledgement, required because the template declares an
  `AWS::IAM::ManagedPolicy` (the emergency Bedrock deny) and an `AWS::IAM::Role`
  (the one Budgets assumes to attach it). Guided mode supplies the capability
  for you, so **you do not pass `--capabilities` on a guided deploy**. Only a
  bare `sam deploy` with no saved config needs `--capabilities CAPABILITY_IAM`
  spelled out.
- **A warning that the Function URL has no authorization.** Expected:
  `AuthType: NONE` is deliberate, and the `x-bench-token` check plus the
  fetch allowlist are what stand in for it. Answer yes.

`CAPABILITY_IAM` is sufficient because neither IAM resource sets a custom name.
If one ever gains a `RoleName` or `ManagedPolicyName`, CloudFormation starts
demanding `CAPABILITY_NAMED_IAM` instead, and the error does not explain why.

Saving answers to `samconfig.toml` is safe. The file is gitignored (root
`.gitignore`), so the real token will not be committed, and it makes subsequent
deploys a bare `sam build && sam deploy` with the capability already recorded.

### After deploy

- `sam deploy` prints `BenchExtractFunctionUrl`. Set it as
  `VITE_BENCH_EXTRACT_URL`, and the token as `VITE_BENCH_ACCESS_TOKEN`, in a
  local `.env` and as GitHub Actions secrets for
  [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml).
- **Confirm every `AlertEmail` subscription.** The two budgets and the SNS
  alarm topic each send their own confirmation link, and each is silent until
  clicked. Check they show `Confirmed`; do not assume.
- Confirm `Cors.AllowOrigins` in `template.yaml` matches the real deployed
  domains (currently `simostack.com` / `www.simostack.com`).
- Pick real values for `BudgetMonthlyLimitUsd` and `EarlyWarningBudgetUsd`. The
  defaults (5 and 1) are placeholders.

## Before every subsequent deploy

> ⚠️ **Check the alarm state and your email for a kill-switch trip first.** The
> kill switch changes reserved concurrency outside CloudFormation, so the stack
> is out of sync with reality afterwards. A routine `sam deploy` silently
> resets concurrency to the template value and reopens the endpoint. Do not
> deploy your way out of an incident.

Otherwise: `sam build && sam deploy`.

## Incident recovery

Neither circuit breaker self-heals, on purpose. If one fired, something was
wrong and it should be understood before the endpoint is live again.

After the kill switch fired:

```bash
aws lambda put-function-concurrency \
  --function-name bench-extract --reserved-concurrent-executions 1
```

After the budget action fired: Budgets → Actions → Revert, in the console.

## Not yet done / not verifiable from this sandbox

- No SAM CLI or AWS credentials here, so `sam validate`/`sam build` have not
  run against `template.yaml`; review it for typos before deploying.
  `extractReadableText`/`validateExtraction` were exercised locally against
  canned fixtures; the real Bedrock call has not been.
- `realestate.com.au` is in the fetch allowlist because it was already wired
  up, not because it has been tested against a real listing. `domain.com.au` is
  the verified-working pair.
- The alarm → SNS → kill-switch chain has not been exercised end to end. Worth
  one deliberate test after deploy (temporarily drop the alarm threshold, or
  invoke `bench-extract-kill-switch` directly) to confirm it can actually set
  concurrency to 0, then restore concurrency to 1.
- Log retention and alerting for extraction failures are not set up.
