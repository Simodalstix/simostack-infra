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
known gaps live in [`SECURITY.md`](../SECURITY.md) at this repo's root. Read
that before changing a guardrail; read this before deploying one.

## Why Bedrock, not the direct Anthropic API

IAM auth (`bedrock:InvokeModel` on the execution role) means no static
Anthropic API key to leak or rotate. Billing lands in the same AWS account,
so one Budget alert covers both. Only dependency: the official
`@aws-sdk/client-bedrock-runtime`.

## What bounds spend

Four layers, fastest to slowest. Layer 1 is account-level and not in this
template; the rest are. See [`SECURITY.md`](../SECURITY.md) for why each is
shaped this way.

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

### Layer 3's two halves fail independently

Layer 3 does two things off one SNS topic, and they do not stand or fall
together. Stopping the spend is the kill-switch Lambda, subscribed by
CloudFormation, which confirms itself and stays subscribed. Telling you it
happened is an email subscription on the same topic, which needs a human to
click a link and is deleted if nobody does within about three days.

So the expected failure is the notification half alone, and it is asymmetric in
an unhelpful direction. Spend still stops: the alarm fires, the Lambda zeroes
reserved concurrency, and nothing reaches Bedrock. What is lost is any account
of why. The tool is simply down, every request throttles, and no message exists
anywhere connecting that to a breaker. **Read a kill-switch trip as an outage
that arrives with no explanation attached, not as an alert you might have
missed.** Reserved concurrency at 0 on `bench-extract` is the only symptom, and
you only see it if you already suspected it.

The diagnostic surface hides this rather than surfacing it. The topic reports
`SubscriptionsConfirmed: 1`, which looks like a healthy topic and is not: the
one confirmed subscriber is the Lambda doing the killing, not the human being
told about it. That count cannot distinguish "email confirmed" from "email
deleted", so checking it is worse than not checking. "After deploy" below has
the check that does work, and "Testing the kill switch" has the drill that
exercises both halves rather than the easy one.

### Why the numbers are $10 and $1

`EarlyWarningBudgetUsd = 1`. Measured Bedrock spend on this account is $0.00,
so $1 is a clean anomaly signal rather than a threshold with a margin in it.
Being wrong costs one email.

`BudgetMonthlyLimitUsd = 10`, not 5:

- Expected worst-case personal usage came out around $3.25/month. Against $5
  that is only about 35% headroom, and it sits on top of a per-token rate that
  was estimated, not verified. Retries, or listing text longer than the 4k-token
  sample the estimate was built from, eat that headroom.
- The two failure directions are not symmetric. Overshooting costs a few dollars
  and is already bounded from below by faster layers: the kill switch caps any
  single incident at roughly $0.65, and `ReservedConcurrentExecutions: 1` caps
  the burn rate. Undershooting fires the explicit `Deny` on the execution role,
  so real users get `AccessDenied` and the first notice of it is somebody
  mentioning the site is broken.
- $10 is still roughly 1,500x measured spend. It has not stopped being a smoke
  alarm.

Two bounds on what this number can actually do, both worth knowing before
leaning on it:

- **It is the slow-leak detector, not the fast breaker.** It runs on Cost
  Explorer data and lags 6-24 hours, so it cannot catch a runaway loop inside
  the window that matters. Layers 1-3 above are what bound a fast incident;
  this layer bounds a slow one.
- **It is account-wide for Bedrock, not scoped to this function.** The
  `CostFilters` on the budget select the Amazon Bedrock service, not this
  Lambda, because per-function attribution is not available at that granularity.
  So any second Bedrock workload on this account shares the same $10 and will
  drag the breaker toward tripping on spend this function never caused. Adding
  one is the trigger to revisit the number, and probably to split the budget.

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
  (`ap-southeast-2` or `ap-southeast-4`). Unlike a bare foundation-model ID, it
  can't be repointed at `us-east-1` to chase availability.
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
cd bench-extract
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
- **Confirm the SNS alarm subscription, and do it within three days.** This is
  the one alerting path with a confirmation handshake, and it is the one that
  silently rots. The two budgets use Budgets' own EMAIL subscribers, which have
  no confirmation step and start working immediately. The SNS topic does not:
  CloudFormation creates the email subscription in `PendingConfirmation`, AWS
  emails a link, and **an unconfirmed subscription is deleted after about three
  days**. When that happens it does not show up as `PendingConfirmation`, it
  disappears entirely, so a later check finds a topic with no email on it and
  nothing anywhere saying there used to be one.

  ```bash
  aws sns list-subscriptions-by-topic --region ap-southeast-2 \
    --topic-arn arn:aws:sns:ap-southeast-2:<account-id>:bench-extract-invocation-alarm \
    --query 'Subscriptions[].{Protocol:Protocol,Endpoint:Endpoint}' --output table
  ```

  Expect two rows, one `lambda` and one `email`. A single `lambda` row means the
  email is gone and the kill switch will fire without telling anyone.

  List the subscriptions; do not count them. `aws sns get-topic-attributes` is
  the shorter command and it is the one that misleads. With the email deleted it
  reports `SubscriptionsConfirmed: 1` and `SubscriptionsPending: 0`, which reads
  as a healthy topic, because the kill-switch Lambda subscribes itself and needs
  no confirmation. The count is never 0 and never says anything about the email.

  The fix is a redeploy to recreate the pending subscription, then clicking the
  link. Verified missing on 2026-08-17 for exactly this reason, nine days after
  the topic was created on 2026-08-08.
- Confirm `Cors.AllowOrigins` in `template.yaml` matches the real deployed
  domains (currently `simostack.com` / `www.simostack.com`).

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

Work out **which** one fired before touching anything. They present differently:

- **Kill switch:** requests to the Function URL are throttled outright. Reserved
  concurrency reads 0.
- **Budget action:** the Function URL still answers, the handler still runs, and
  only the Bedrock call fails, with `AccessDenied` on `bedrock:InvokeModel`. This
  reads like a Bedrock outage or a broken IAM change rather than a breaker doing
  its job, which is why the procedure below exists.

### After the kill switch fired

```bash
aws lambda put-function-concurrency \
  --function-name bench-extract --reserved-concurrent-executions 1
```

### After the budget action fired

The deny is a managed policy (`BenchDenyBedrockPolicy`) that AWS Budgets
attaches to the function's execution role. A `Deny` beats the role's own
`Allow`, so nothing else about the function changes. Do not fix this by editing
IAM by hand: reverse the action, so Budgets' own record of state matches
reality and the action returns to `STANDBY` armed for next time.

Physical names carry a stack-generated suffix and change if the stack is ever
replaced, so discover them rather than pasting them. As of 2026-08-17 they are
role `sam-app-BenchExtractFunctionRole-JkOIOYE75BYa` and policy
`sam-app-BenchDenyBedrockPolicy-7gDgd1m8I3VO`.

1. **Confirm it is really the budget action**, not a hand-made IAM mistake. A
   status of `EXECUTION_SUCCESS` means it fired; `STANDBY` means it did not and
   the `AccessDenied` is coming from somewhere else.

   ```bash
   ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   aws budgets describe-budget-actions-for-budget \
     --account-id "$ACCOUNT_ID" --budget-name bench-bedrock-monthly \
     --query 'Actions[].{Id:ActionId,Status:Status}'
   ```

2. **Confirm the policy is actually attached**, which is the same fact seen from
   the IAM side:

   ```bash
   ROLE=$(aws cloudformation describe-stack-resources \
     --region ap-southeast-2 --stack-name sam-app \
     --logical-resource-id BenchExtractFunctionRole \
     --query 'StackResources[0].PhysicalResourceId' --output text)
   aws iam list-attached-role-policies --role-name "$ROLE"
   ```

3. **Find out what spent the money before reverting.** This layer only trips on
   real dollars, so something did. Reverting first and investigating later means
   reopening the tap on a cause you do not understand yet.

   ```bash
   aws ce get-cost-and-usage --granularity MONTHLY \
     --time-period Start=$(date -u +%Y-%m-01),End=$(date -u -d '+1 month' +%Y-%m-01) \
     --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE \
     --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Bedrock"]}}'
   ```

   Cross-check against the function's own logs for the same window, since the
   budget is account-wide and the spend may not be this function's at all.

4. **Decide the limit before reversing, not after.** If actual spend is still
   above `BudgetMonthlyLimitUsd`, the action re-fires on the next evaluation and
   you get the same `AccessDenied` back within hours. So either raise
   `BudgetMonthlyLimitUsd` and deploy first, or accept that Bedrock stays denied
   until the calendar month rolls over and the budget resets.

5. **Reverse the action.**

   ```bash
   aws budgets execute-budget-action \
     --account-id "$ACCOUNT_ID" --budget-name bench-bedrock-monthly \
     --action-id <action-id-from-step-1> \
     --execution-type REVERSE_BUDGET_ACTION
   ```

   Console equivalent: Billing → Budgets → `bench-bedrock-monthly` → Actions →
   Revert. Note that `aws budgets` is a global endpoint, so these calls need no
   `--region`, unlike every other command in this file.

6. **Verify both sides came back.** Re-run steps 1 and 2: status should return to
   `STANDBY` and `list-attached-role-policies` should no longer list
   `BenchDenyBedrockPolicy`. Then exercise the real path once through the site's
   add-listing flow, because a successful reverse still leaves a cold IAM cache
   for a short window and the first call afterwards can still fail.

## Testing the kill switch

The chain has never fired in anger, so until this drill is run the only evidence
it works is that the template reads correctly. Run it before relying on the
breaker, and again after any deploy that recreates the SNS topic, because a
recreated topic starts with an unconfirmed email subscription and a three-day
fuse on it.

**1. Confirm the email subscription is actually there.** This is a precondition,
not a formality: the notification half is the half that silently disappears and
the half this drill exists to test.

```bash
aws sns list-subscriptions-by-topic --region ap-southeast-2 \
  --topic-arn arn:aws:sns:ap-southeast-2:<account-id>:bench-extract-invocation-alarm \
  --query 'Subscriptions[].{Protocol:Protocol,Endpoint:Endpoint}' --output table
```

Two rows, `lambda` and `email`. If only the `lambda` row is there, stop and fix
that first ("After deploy" above). Running the drill against a topic with no
email on it can only exercise the half that was never in doubt, and it will look
like a pass.

**2. Fire the alarm.** Check it reads `OK` first. `set-alarm-state` invokes
actions only when the state actually changes, so forcing `ALARM` on an alarm
already in `ALARM` does nothing and reads as a broken chain.

```bash
aws cloudwatch describe-alarms --region ap-southeast-2 \
  --alarm-names bench-extract-high-invocations \
  --query 'MetricAlarms[0].StateValue' --output text

aws cloudwatch set-alarm-state --region ap-southeast-2 \
  --alarm-name bench-extract-high-invocations \
  --state-value ALARM \
  --state-reason 'Manual drill of the kill-switch chain.'
```

This drives the alarm's real `AlarmActions`, so one command exercises every hop:
alarm → SNS → the kill-switch Lambda *and* the email subscription. It changes no
configuration. The forced state is transient, overwritten from the metric at the
next evaluation period, so the alarm returns to `OK` within about five minutes on
its own. That return fires nothing, because the alarm has no `OKActions`;
restoring concurrency in step 4 is still manual and still yours.

Two things this deliberately is not:

- **Not `aws lambda invoke` on `bench-extract-kill-switch`.** It is the obvious
  move and it tests the wrong thing. The email comes from SNS fanning the
  message out to its second subscriber, not from the kill-switch Lambda, which
  only calls `PutFunctionConcurrency` and logs. Invoking the function directly
  drives concurrency to 0 while skipping the notification path entirely, which
  is the exact blind spot this drill exists to close.
- **Not lowering the alarm threshold.** That edits a live guardrail and then
  depends on you remembering to put it back, and it still needs real traffic
  before it trips.

To exercise the topic and below without involving the alarm, which is the useful
check straight after a redeploy has recreated the email subscription:

```bash
aws sns publish --region ap-southeast-2 \
  --topic-arn arn:aws:sns:ap-southeast-2:<account-id>:bench-extract-invocation-alarm \
  --subject 'DRILL: bench-extract kill switch' \
  --message 'Manual drill, not a real alarm. Expect concurrency 0 on bench-extract.'
```

**3. Pass condition, both halves.**

```bash
aws lambda get-function-concurrency --function-name bench-extract \
  --region ap-southeast-2
```

1. `ReservedConcurrentExecutions` reads `0`.
2. The alarm email arrives at `AlertEmail`. Allow a minute.

Half a pass is a fail, and specifically a fail that needs fixing before the
breaker means anything. Checking concurrency alone is exactly what let the
missing subscription sit undetected from 2026-08-08 to 2026-08-17.

**4. Restore.** Nothing does this for you; the chain has no OK action, on
purpose.

```bash
aws lambda put-function-concurrency \
  --function-name bench-extract --reserved-concurrent-executions 1
```

**What the drill still does not cover:** whether the alarm decides to fire at
the right moment. `set-alarm-state` forces the transition rather than earning it,
so everything from `ALARM` onward is proven while the `Invocations` metric, the
`FunctionName` dimension, the 300-second period and the threshold of 100 are all
still taken on trust. Only real traffic exercises those. The honest claim after a
passing drill is "the chain fires correctly once the alarm fires", not "the alarm
fires at the right time".

## Not yet done

- The alarm → SNS → kill-switch chain has not been exercised end to end. The
  drill is written up under "Testing the kill switch" above; run it once the
  email subscription is confirmed.
- **The SNS email subscription on the alarm topic is currently missing** (checked
  2026-08-17: one confirmed subscriber, the kill-switch Lambda). It expired
  unconfirmed. Until a redeploy recreates it and the link is clicked, the kill
  switch will fire silently. The budget emails are unaffected.
- The budget-action reverse procedure above is written but, like the kill switch,
  has never been run. It is derived from the template and the Budgets API, not
  from an observed trip.
- `BudgetMonthlyLimitUsd` is account-wide for Bedrock rather than scoped to this
  function. A second Bedrock workload on this account is the trigger to revisit
  the number and probably split the budget.
- Log retention and alerting for extraction failures are not set up.
