# bench-extract

Backend for Bench's "+ Add listing" flow. One Lambda behind a Function URL
(no API Gateway, no VPC). Given a pasted Domain/realestate.com.au URL or raw
listing text, it fetches/reads the text server-side and asks Claude Haiku
(via Amazon Bedrock) for structured listing facts as JSON.

`index.mjs` is the request/response contract — keep it byte-for-byte in sync
with `src/components/bench/AddListingFlow.vue`.

## Why Bedrock, not the direct Anthropic API

IAM auth (`bedrock:InvokeModel` on the execution role) means no static
Anthropic API key to leak or rotate. Billing lands in the same AWS account,
so one Budget alert covers both. Only dependency: the official
`@aws-sdk/client-bedrock-runtime`.

## Auth and spend caps

The Function URL is `AuthType: NONE` — CORS blocks browsers, not `curl` or
scanners. `x-bench-token` (checked against `BenchAccessToken`) filters out
opportunistic bots; it's not real security since the token lives in the
public JS bundle.

Three layers actually bound cost, fastest to slowest:

1. **Bedrock Service Quota** (manual, account-level, not in this template) —
   enforced synchronously on every `InvokeModel` call. The only layer with no
   lag. Lower the Haiku on-demand rate quota in Service Quotas console to
   ~1-2x realistic personal usage. Lowering below default usually needs a
   Support ticket (the console form is built for increases).
2. **`ReservedConcurrentExecutions: 2`** — caps parallel requests, bounds how
   fast a burst can spend.
3. **Budget + BudgetsAction** — once real Bedrock spend hits
   `BudgetMonthlyLimitUsd`, AWS attaches a deny-`bedrock:InvokeModel` policy
   to the execution role. Runs off Cost Explorer data, so it can lag 6-24h
   behind actual spend — the backstop for slow-drip abuse, not fast loops.
   Doesn't self-heal: revert manually (Budgets → Actions → Revert) once
   spend is under control. You get an email at 80% and at the deny itself.

## Deploy

Requires [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
and AWS credentials — not set up in this sandbox.

**Before first deploy:**

- Enable Bedrock model access for Claude Haiku (Bedrock console → Model
  access) in whichever region `BedrockRegion` points at.
- Confirm the real `BedrockModelId` string and its regional availability:
  ```bash
  aws bedrock list-foundation-models --region ap-southeast-2 \
    --query "modelSummaries[?contains(modelId, 'haiku')].modelId"
  ```
  Newer models often land in `us-east-1`/`us-west-2` first — point
  `BedrockRegion` there if needed (cross-region calls work fine, just adds
  latency).
- Lower the Bedrock rate quota per the spend-cap section above.

```bash
cd lambda/bench-extract
sam build
sam deploy --guided   # prompts for BenchAccessToken, BedrockModelId,
                       # BedrockRegion, BudgetMonthlyLimitUsd, AlertEmail
```

Generate `BenchAccessToken` with `openssl rand -hex 24`. It's `NoEcho: true`
so it never appears in stack logs — if you save answers to `samconfig.toml`,
don't bake the real token into a committed copy; pass it via
`--parameter-overrides` or leave it for the guided prompt.

Subsequent deploys: `sam build && sam deploy`.

After deploy, `sam deploy` prints `BenchExtractFunctionUrl`. Set that as
`VITE_BENCH_EXTRACT_URL`, and your token as `VITE_BENCH_ACCESS_TOKEN`, in
local `.env` and wherever the production build sources env vars.

## Not yet done / not verifiable from this sandbox

- No SAM CLI or AWS credentials here — `sam validate`/`sam build` haven't
  run against `template.yaml`; review it for typos before deploying.
  `extractReadableText`/`validateExtraction` were exercised locally against
  canned fixtures; the real Bedrock call has not been.
- Bedrock model access, quota tuning, and `sam deploy --guided` all need to
  be run by hand with real credentials.
- Confirm `Cors.AllowOrigins` in `template.yaml` matches the real deployed
  domain(s) (currently `simostack.com` / `www.simostack.com`).
- Set `VITE_BENCH_EXTRACT_URL` / `VITE_BENCH_ACCESS_TOKEN` in prod build env
  (GitHub Actions secret feeding `.github/workflows/deploy.yml`).
- Confirm the `AlertEmail` subscription — AWS emails a confirmation link
  after first deploy; notifications are silent until it's clicked.
- Pick a real `BudgetMonthlyLimitUsd` — default (5) is a placeholder.
- Decide on log retention / alerting for extraction failures — not set up.
