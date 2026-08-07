# bench-extract

Backend for Bench's "+ Add listing" flow. One Lambda behind a Function URL
(no API Gateway, no VPC). Given a pasted Domain/realestate.com.au URL or raw
listing text, it fetches/reads the text server-side and asks Claude Haiku
(via Amazon Bedrock) for structured listing facts as JSON.

`index.mjs` is the request/response contract. Keep it byte-for-byte in sync
with `src/components/bench/AddListingFlow.vue`.

## Why Bedrock, not the direct Anthropic API

IAM auth (`bedrock:InvokeModel` on the execution role) means no static
Anthropic API key to leak or rotate. Billing lands in the same AWS account,
so one Budget alert covers both. Only dependency: the official
`@aws-sdk/client-bedrock-runtime`.

## Auth and spend caps

The Function URL is `AuthType: NONE`, so CORS blocks browsers, not `curl` or
scanners. `x-bench-token` (checked against `BenchAccessToken`) filters out
opportunistic bots; it's not real security since the token lives in the
public JS bundle.

`index.mjs` also refuses to fetch anything outside an exact-host allowlist
(`domain.com.au` / `realestate.com.au`, https only). Without that, the handler
is an open fetch proxy for whoever holds the token.

Layers that actually bound cost, fastest to slowest:

1. **Bedrock Service Quota** (manual, account-level, not in this template):
   enforced synchronously on every `InvokeModel` call. The only layer with no
   lag. Lower the Haiku on-demand rate quota in Service Quotas console to
   ~1-2x realistic personal usage. Lowering below default usually needs a
   Support ticket (the console form is built for increases).
2. **`ReservedConcurrentExecutions: 1`** caps parallel requests and bounds how
   fast a burst can spend. Bounds the _rate_, never the total.
3. **CloudWatch alarm → kill switch** (~1-6 min): >100 invocations in 5
   minutes fires `BenchHighInvocationAlarm`, which notifies an SNS topic that
   invokes `bench-extract-kill-switch`, which sets reserved concurrency to
   **0**. That throttles every further invocation before any code runs. Fast
   and dumb: it counts requests, so a flood of cheap 401s will trip it too.
4. **Budget + BudgetsAction**: once real Bedrock spend hits
   `BudgetMonthlyLimitUsd`, AWS attaches a deny-`bedrock:InvokeModel` policy
   to the execution role. Runs off Cost Explorer data, so it can lag 6-24h
   behind actual spend. It is the backstop for slow-drip abuse, not fast loops.
   You get an email at 80% and at the deny itself.

Plus a separate email-only budget at `EarlyWarningBudgetUsd` (default $1),
with both ACTUAL and FORECASTED notifications. It stops nothing; it exists so
the first news of creeping spend isn't a circuit breaker tripping.

Neither circuit breaker self-heals, on purpose. Recovery is manual:

```bash
# After the kill switch fired:
aws lambda put-function-concurrency \
  --function-name bench-extract --reserved-concurrent-executions 1
```

After the budget action: Budgets → Actions → Revert in the console.

⚠️ The kill switch changes concurrency outside CloudFormation, so the stack is
then out of sync. **A `sam deploy` resets concurrency to the template value
and turns the endpoint back on**, so don't deploy your way out of an incident.

Full reasoning, the account-level items that live outside this template, and
the known gaps: [`SECURITY.md`](../../SECURITY.md) at the repo root.

## Deploy

Requires [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
and AWS credentials, neither set up in this sandbox.

**Before first deploy:** work through the pre-deploy checklist in
[`SECURITY.md`](../../SECURITY.md). The template-side items are already in
`template.yaml`; these are the ones you have to do by hand:

- Enable Bedrock model access for Claude Haiku (Bedrock console → Model
  access) in whichever region `BedrockRegion` points at. Enable **only** that
  model. A blanket enable removes a layer, and Opus-tier pricing is roughly
  an order of magnitude above Haiku's.
- Confirm the real `BedrockModelId` string and its regional availability:
  ```bash
  aws bedrock list-foundation-models --region ap-southeast-2 \
    --query "modelSummaries[?contains(modelId, 'haiku')].modelId"
  ```
  Newer models often land in `us-east-1`/`us-west-2` first, so point
  `BedrockRegion` there if needed (cross-region calls work fine, just adds
  latency).
- Lower the Bedrock rate quota per the spend-cap section above.

```bash
cd lambda/bench-extract
sam build
sam deploy --guided   # prompts for BenchAccessToken, BedrockModelId,
                       # BedrockRegion, BudgetMonthlyLimitUsd,
                       # EarlyWarningBudgetUsd, AlertEmail
                       # NOTE: needs CAPABILITY_IAM (new kill-switch role)
```

Generate `BenchAccessToken` with `openssl rand -hex 24`. It's `NoEcho: true`
so it never appears in stack logs. If you save answers to `samconfig.toml`,
don't bake the real token into a committed copy; pass it via
`--parameter-overrides` or leave it for the guided prompt.

Subsequent deploys: `sam build && sam deploy`.

After deploy, `sam deploy` prints `BenchExtractFunctionUrl`. Set that as
`VITE_BENCH_EXTRACT_URL`, and your token as `VITE_BENCH_ACCESS_TOKEN`, in
local `.env` and wherever the production build sources env vars.

## Not yet done / not verifiable from this sandbox

- No SAM CLI or AWS credentials here, so `sam validate`/`sam build` haven't
  run against `template.yaml`; review it for typos before deploying.
  `extractReadableText`/`validateExtraction` were exercised locally against
  canned fixtures; the real Bedrock call has not been.
- Bedrock model access, quota tuning, and `sam deploy --guided` all need to
  be run by hand with real credentials.
- Confirm `Cors.AllowOrigins` in `template.yaml` matches the real deployed
  domain(s) (currently `simostack.com` / `www.simostack.com`).
- Set `VITE_BENCH_EXTRACT_URL` / `VITE_BENCH_ACCESS_TOKEN` in prod build env
  (GitHub Actions secret feeding `.github/workflows/deploy.yml`).
- Confirm **every** `AlertEmail` subscription. The two budgets and the SNS
  alarm topic each send their own confirmation link after first deploy, and
  each is silent until clicked. Check they show `Confirmed`; don't assume.
- Pick a real `BudgetMonthlyLimitUsd`. The default (5) is a placeholder. Same for
  `EarlyWarningBudgetUsd` (default 1).
- The alarm → SNS → kill-switch chain hasn't been exercised end to end. Worth
  one deliberate test after deploy (temporarily drop the alarm threshold, or
  invoke `bench-extract-kill-switch` directly) to confirm it can actually set
  concurrency to 0, then restore concurrency to 1.
- Decide on log retention / alerting for extraction failures. Not set up.
