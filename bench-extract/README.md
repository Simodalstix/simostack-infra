# bench-extract

The backend half of Bench's "+ Add listing" flow. One Lambda, exposed via a
Function URL (no API Gateway, no VPC, no Cognito/IAM auth layer on the URL
itself). Given a pasted Domain/realestate.com.au URL or pasted raw listing
text, it fetches/reads the text server-side and asks Claude Haiku — via
Amazon Bedrock — to return structured listing facts as JSON.

See `index.mjs` for the request/response contract — it must stay byte-for-byte
in sync with what `src/components/bench/AddListingFlow.vue` sends and expects.

## Why Bedrock, not the direct Anthropic API

Auth to Bedrock is IAM — the Lambda's execution role gets a narrowly-scoped
`bedrock:InvokeModel` permission (see `template.yaml`), so there is **no
static Anthropic API key anywhere**: not in an env var, not to leak, not to
rotate. Billing lands on the AWS account this Lambda already runs in, so the
same AWS Budgets alert you'd want for Lambda costs covers this too. The one
declared npm dependency, `@aws-sdk/client-bedrock-runtime`, is the official
AWS SDK — a materially smaller supply-chain risk than a random package, and
worth it now that there's no API key to justify a zero-dependency build.

## The Function URL is still unauthenticated — the shared-secret token is the real gate

`AuthType: NONE` on the Function URL means CORS is the *only* browser-level
restriction, and CORS does nothing to stop a direct HTTP request (`curl`, a
bot scanning for public Lambda URLs — a real and common scan target). Every
request must carry an `x-bench-token` header matching the `BenchAccessToken`
deploy parameter, checked first thing in the handler, before any fetch or
Bedrock call happens. This isn't real security (anyone who reads the
frontend's JS bundle can find the token), but it silently rejects the
opportunistic bots that make up most of the actual threat model here. The
frontend sends it from `VITE_BENCH_ACCESS_TOKEN` — set the same value on both
sides.

`ReservedConcurrentExecutions: 2` on the function further bounds the blast
radius of any burst that does get through.

**Neither of those is a spend cap** — they raise the bar against opportunistic
bots and bound the *rate* of spend, but a determined abuser who reads the
token out of the public JS bundle could still hit the endpoint indefinitely
and accumulate a real bill over time, just a rate-limited one. The actual
cap is the Budget + BudgetsAction below: once this month's real Bedrock spend
(account-wide) reaches `BudgetMonthlyLimitUsd`, AWS automatically attaches a
deny-`bedrock:InvokeModel` policy to this function's execution role — the
function keeps existing and the Function URL keeps responding, but every
Bedrock call fails with `AccessDenied` until you manually detach the policy
(Console: Budgets → your budget → Actions tab → Revert, or
`aws budgets describe-budget-actions` + a manual detach via the console/CLI —
this does not resolve itself at the start of the next billing period).
You'll also get an email at 80% of the limit as an early warning, and again
when the deny actually fires at 100%.

## Deploy

Requires the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
and AWS credentials for the target account — neither is set up in this
sandbox, so deployment has not been run from here.

### One-time: enable Bedrock model access

Before the first deploy, open the **Amazon Bedrock console → Model access**
in the target region and enable access to the Claude Haiku model (a one-time
toggle/EULA click per account per region — no purchase, no separate vendor
account). Do this in whichever region `BedrockRegion` points at (see below).

### Verify the model ID and region before first deploy

`template.yaml`'s `BedrockModelId` parameter defaults to
`anthropic.claude-haiku-4-5-20251001-v1:0`, following Bedrock's established
"dated snapshot + `-v1:0`" naming convention for Claude models — but this
wasn't confirmed against a live Bedrock catalog from this sandbox. Before
deploying, check the real ID and its regional availability:

```bash
aws bedrock list-foundation-models --region ap-southeast-2 \
  --query "modelSummaries[?contains(modelId, 'haiku')].modelId"
```

If Haiku 4.5 isn't listed in `ap-southeast-2` yet (newer models often land in
`us-east-1`/`us-west-2` first), pass a different `BedrockRegion` at deploy —
the Lambda can call Bedrock cross-region fine, it just adds a little latency.
Update the `BedrockModelId` parameter if the real string differs from the
default.

### Deploy commands

First deploy (interactive — walks through stack name, region, and prompts for
the `BenchAccessToken`, `BedrockModelId`, `BedrockRegion`,
`BudgetMonthlyLimitUsd`, and `AlertEmail` parameters; can save answers to a
gitignored `samconfig.toml` so later deploys are one command):

```bash
cd lambda/bench-extract
sam build
sam deploy --guided
```

Generate a token for `BenchAccessToken` with something like
`openssl rand -hex 24` — it's a shared secret, not a password you need to
remember.

Subsequent deploys, once `samconfig.toml` exists:

```bash
sam build && sam deploy
```

`BenchAccessToken` is `NoEcho: true` in `template.yaml`, so it never appears
in stack event logs or `describe-stacks` output. If you use `samconfig.toml`
to save deploy parameters for convenience, do not commit a copy with the real
token baked into `parameter_overrides` — pass it with
`--parameter-overrides BenchAccessToken=...` on the command line instead, or
leave it for the guided prompt to ask each time.

After a successful deploy, `sam deploy` prints the `BenchExtractFunctionUrl`
stack output. Set that as `VITE_BENCH_EXTRACT_URL`, and the same token you
deployed with as `VITE_BENCH_ACCESS_TOKEN`, in the frontend's environment
(local `.env` for dev, and wherever the GitHub Actions deploy workflow
sources build-time env vars for production) so `AddListingFlow.vue` knows
where to POST and how to authenticate.

## Local validation without a deploy

No SAM CLI or AWS credentials are available in this environment, so
`sam validate` / `sam build` haven't been run against this template — review
`template.yaml` for typos before the first real deploy. The pure text-
extraction and output-validation helpers (`extractReadableText`,
`validateExtraction`) are exported from `index.mjs` and were exercised with a
local script against canned HTML/JSON fixtures (no real network calls); the
Bedrock call itself has not been exercised against a real account from here.

## What's still manual before this goes live

- Enable Bedrock model access for Claude Haiku in the target region (Console
  step above) — a request to a model without access enabled fails at
  `InvokeModel` time, not at deploy time.
- Verify the `BedrockModelId` string and `BedrockRegion` (see above) — this
  is the one detail this build couldn't confirm without live AWS access.
- Run `sam deploy --guided` yourself with real AWS credentials — this was
  intentionally not done from here.
- Confirm the production origin(s) in `template.yaml`'s `Cors.AllowOrigins`
  match the site's actual deployed domain(s) (currently
  `https://simostack.com` / `https://www.simostack.com` — adjust if the site
  serves from a different apex/subdomain via CloudFront).
- Set `VITE_BENCH_EXTRACT_URL` and `VITE_BENCH_ACCESS_TOKEN` from the deploy
  output/parameter in both local dev env and the production build environment
  (GitHub Actions secret/variable feeding `npm run build` in
  `.github/workflows/deploy.yml`).
- Confirm the `AlertEmail` subscription — AWS sends a confirmation email
  after the first deploy; budget notifications (and the deny action itself)
  are silent until it's clicked.
- Pick a real `BudgetMonthlyLimitUsd` before deploying — the default (5) is a
  placeholder. Set it comfortably above what you'd ever actually spend so it
  only trips on abuse.
- If the deny action ever fires, you'll need to manually revert it (Console:
  Budgets → Actions → Revert) to restore extraction — it does not reset
  itself at the start of the next month.
- Decide on log retention / basic alerting if you want visibility into
  extraction failures in practice — not set up here.
