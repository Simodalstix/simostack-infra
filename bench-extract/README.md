# bench-extract

Backend for Bench's "+ Add listing" flow. One Lambda behind a Function URL
(no API Gateway, no VPC). Given raw listing text, or a Domain /
realestate.com.au URL it fetches server-side, it asks Claude Haiku (via Amazon
Bedrock) for structured listing facts as JSON.

**Pasted text is the working input.** Both allowlisted sites block server-side
fetching at the CDN edge, so the URL path returns `URL_FETCH_BLOCKED` every
time and the UI leads with paste. The allowlist comment in `index.mjs` has the
evidence and what it would take to fix; it is not repeated here.

`index.mjs` is the request/response contract. Its consumer lives in the
frontend repo (`vue-simostack`) at `src/components/bench/AddListingFlow.vue`.
Keep the two byte-for-byte in sync. Nothing enforces this across the repo
boundary, so a change to the contract here is only half a change until that
file is updated too.

**This file is the procedure: how to deploy it and what to do when a circuit
breaker fires.** The reasoning behind every guardrail, the threat model and the
known gaps live in `SECURITY.md` at the root of the `vue-simostack` repo. Read
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
  not the extra burst capacity cross-region inference normally gives you. If you
  ever opt into Melbourne, enable Haiku access there too and the second region
  starts carrying load. The IAM policy already grants it, so nothing in the
  template needs to change. To check whether it is opted in:

  ```bash
  aws account get-region-opt-status --region-name ap-southeast-4
  ```

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
- **Seed the access token in SSM Parameter Store**, in the deploy region. The
  template takes the parameter NAME and resolves it to the value at deploy
  time, so the stack fails at validation if this does not exist yet:

  ```bash
  aws ssm put-parameter --name /bench/access-token --type String \
    --value "$(openssl rand -hex 24)" --region ap-southeast-2
  ```

### Deploy

```bash
cd lambda/bench-extract
sam build
sam deploy --guided
```

Guided mode prompts for `BenchAccessTokenParameterName`, `BedrockModelId`,
`BedrockFoundationModelId`, `BedrockRegion`, `BudgetMonthlyLimitUsd`,
`EarlyWarningBudgetUsd` and `AlertEmail`. The two model parameters are the same
string with and without the `au.` prefix: the profile the request names, and the
underlying model IAM has to authorize it against. Change one, change both.

`BenchAccessTokenParameterName` defaults to `/bench/access-token` and is the
SSM parameter's **name**, not the token. Accept the default and CloudFormation
fetches the value itself, so the token is never typed at a prompt and never
lands in `samconfig.toml`.

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

Saving answers to `samconfig.toml` is worth doing: it makes subsequent deploys
a bare `sam build && sam deploy` with the capability already recorded. What it
saves is the SSM parameter's name, never the token, since the token is only
ever resolved by CloudFormation at deploy time. The file stays gitignored
anyway, because it records the stack name, region and alert email.

### After deploy

The deploy ends in this repo but the result is consumed in another one. There
is no pipeline across that boundary: the Function URL is carried over by hand,
and nothing will tell you if you skip it.

- `sam deploy` prints `BenchExtractFunctionUrl`. That value, plus the access
  token, has to be set by hand in the frontend repo (`vue-simostack`) in two
  places, because the site reads them at build time as
  `VITE_BENCH_EXTRACT_URL` and `VITE_BENCH_ACCESS_TOKEN`:
  1. As GitHub Actions repo secrets on `vue-simostack`, which is what the
     deployed site is built with.
  2. In a local `.env` there (`cp .env.example .env` at that repo's root),
     which is what `npm run dev` reads. Its `.gitignore` covers `.env` and
     `.env.*`, so the filled-in copy stays local.

  Leaving both unset is also fine: the add-listing flow falls back to stand-in
  data and spends nothing.
- Then run `scripts/post-deploy.sh` from the root of `vue-simostack` (the
  script lives there, not here, because the check it performs is a comparison
  against that repo's `.env`). It prints the Function URL from the stack and
  says whether the local `.env` still matches. The URL only changes when the
  Lambda is replaced rather than updated in place, and when that happens
  nothing errors: the site keeps calling the old URL and every extraction
  fails as a network error that reads like a Lambda fault. Exit code 2 means
  they differ, so update the `.env` and the GitHub Actions secret.

  Note that the script only checks the local `.env`. A stale GitHub Actions
  secret is invisible to it and to every local test, and shows up only as a
  broken deployed site, so update the secret in the same sitting.
- **Confirm every `AlertEmail` subscription.** The two budgets and the SNS
  alarm topic each send their own confirmation link, and each is silent until
  clicked. Check they show `Confirmed`; do not assume.
- Confirm `Cors.AllowOrigins` in `template.yaml` matches the real deployed
  domains (currently `simostack.com` / `www.simostack.com`).
- Pick real values for `BudgetMonthlyLimitUsd` and `EarlyWarningBudgetUsd`. The
  defaults (5 and 1) are placeholders.

## Access token

`BenchAccessToken` lives in SSM Parameter Store (`/bench/access-token`,
ap-southeast-2), not in `samconfig.toml` and not at a `--guided` prompt.
`template.yaml` takes the parameter name and CloudFormation resolves it to the
value at deploy time.

It is a plain `String`, not a `SecureString`, for two reasons. The technical
one: `AWS::SSM::Parameter::Value<String>` does not accept a SecureString, and
`{{resolve:ssm-secure}}` is restricted to an allowlist of resource properties
that excludes Lambda environment variables, so a SecureString cannot reach
`BENCH_ACCESS_TOKEN` through this template at all. The honest one: this value
is inlined into the public JS bundle as `VITE_BENCH_ACCESS_TOKEN` and is
readable by anyone who loads the site, so encrypting it at rest would be
protecting something already published. SSM is here for the rotation
workflow, not for secrecy. What actually bounds abuse is the Bedrock quota,
`ReservedConcurrentExecutions`, the kill switch and the budget action.

**Rotating it:**

1. ```bash
   aws ssm put-parameter --name /bench/access-token --type String \
     --value "$(openssl rand -hex 24)" --overwrite --region ap-southeast-2
   ```
2. Update `VITE_BENCH_ACCESS_TOKEN` in the local `.env` in `vue-simostack`.
3. Update the `VITE_BENCH_ACCESS_TOKEN` GitHub Actions secret on
   `vue-simostack`.
4. `sam build && sam deploy`, no prompts expected.

Order matters on the way out. The Lambda starts rejecting the old token the
moment step 4 lands, so the deployed site keeps sending the old one until the
next build ships step 3. Either accept a window of failed extractions or push
a rebuild straight after deploying.

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
- The alarm → SNS → kill-switch chain has not been exercised end to end. Worth
  one deliberate test after deploy (temporarily drop the alarm threshold, or
  invoke `bench-extract-kill-switch` directly) to confirm it can actually set
  concurrency to 0, then restore concurrency to 1.
- Log retention and alerting for extraction failures are not set up.
