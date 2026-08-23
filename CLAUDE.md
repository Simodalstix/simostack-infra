# simostack-infra

Backend AWS infra for simostack.com, deployed independently of the frontend
(vue-simostack): separate CI, separate deploy lifecycle, separate repo by
design.

## Structure
- `bench-extract/`: Bedrock-backed Lambda (listing extraction), SAM app. Built
  and deployed.
- `bench-auth/`: Cognito auth for Bench. Phase 1 template authored, **nothing
  deployed and no AWS resources created** (see below).
- `SECURITY.md`: repo-wide threat model and guardrail rationale.
- `README.md`: repo overview, deploy model, cross-repo handoff.
- `.github/workflows/`: one test workflow per service.

## Where the documentation lives

The READMEs are the source of truth and are detailed. Read rather than infer:

- `SECURITY.md`: why each guardrail exists, and the **design checklist for a
  new public Bedrock endpoint**. It applies to every service here, `bench-auth`
  included, not just bench-extract. Read before writing a public endpoint or
  loosening a guardrail.
- `bench-extract/README.md` is the procedure: account prerequisites, first
  deploy, token rotation, incident recovery.
- `bench-auth/README.md`: what the service is meant to replace.

## Conventions

- **Per-service, not workspace-hoisted.** Each service has its own
  `package.json`, lockfile, `node_modules` and vitest config. `sam build` copies
  a service directory expecting deps to resolve from inside it, so don't hoist
  to root, and don't add a root workspace.
- **Deploy is manual**, from within each service dir: `sam build && sam deploy`,
  with `--guided` on first deploy. No CI deploys anything; CI only runs tests.
- **No root-level stack** tying services together, deliberately.
- **`samconfig.toml` and `.aws-sam/` are gitignored repo-wide**, matched at any
  depth (`**/samconfig.toml`), so a new service directory is covered the day it
  is created. `samconfig.toml` holds stack name, region, capabilities and
  `parameter_overrides` (budget caps, alert email, model IDs, and the SSM
  parameter *name*), never the access token itself, which CloudFormation
  resolves from SSM at deploy time. Don't re-run `--guided` casually; its
  prompts overwrite real values with defaults.

## Tests

Per service, from that service's directory:

```bash
cd bench-extract && npm install && npm test   # vitest run
```

Two things in `bench-extract/vitest.config.js` that are load-bearing:

- `@aws-sdk/client-bedrock-runtime` is aliased to a stub in
  `__tests__/stubs/bedrock-runtime.js`. Tests need no network and no AWS
  credentials, and no test should make a real Bedrock call.
- `**/.aws-sam/**` is excluded from discovery. `sam build` copies `__tests__`
  into `.aws-sam/build/`, so without the exclude vitest runs every test twice,
  the second time against a stale gitignored snapshot. Spread
  `configDefaults.exclude`; replacing it silently re-enables `node_modules`.

**Node versions differ on purpose:** local dev is on 22, while `template.yaml`
sets `nodejs24.x` and CI pins Node 24. CI is the only place the code runs on the
version that serves it in production.

## CI

`.github/workflows/bench-extract-tests.yml` runs tests only, no deploy. It is
paths-filtered to `bench-extract/**` plus its own file, and sets
`working-directory: bench-extract` with `cache-dependency-path` pointed at the
service lockfile (the cache step resolves that from the repo root regardless of
`working-directory`).

**A new service gets a new workflow file**, not another branch inside this one:
a repo-wide test job would have to know every service directory or force a root
workspace.

`.github/workflows/bench-auth-tests.yml` is the same shape, path-filtered to
`bench-auth/**`, but it lints CloudFormation instead of running unit tests.
bench-auth is IaC only with no JavaScript, so there is no `package.json` and
nothing for vitest to run; `cfn-lint` is the equivalent check. If bench-auth
ever grows Lambda code (a pre-sign-up trigger, say), add a `npm test` step
rather than replacing the lint one.

## Deployed state (verified 2026-08-21)

- The bench-extract stack is deployed in **`ap-southeast-2` under the stack name
  `sam-app`**, the `--guided` default, never changed. There is no stack named
  `bench-extract`; looking for one and concluding nothing is deployed is the
  easy mistake. The Lambda itself is `bench-extract`.
- Reserved concurrency is 1, matching the template. `bench-extract-high-invocations`
  (logical ID `BenchHighInvocationAlarm`) is in `OK`.
- Budget parameters are deliberate values, not placeholders:
  `BudgetMonthlyLimitUsd=10` and `EarlyWarningBudgetUsd=1`, justified in
  `bench-extract/README.md` under "Why the numbers are $10 and $1". Deployed
  2026-08-21; `bench-bedrock-monthly` reads `10.0 USD` live.
- **The SNS email subscription on `bench-extract-invocation-alarm` is live and
  authenticated as of 2026-08-21** (`PendingConfirmation: false`,
  `ConfirmationWasAuthenticated: true`). It was missing before that: the
  subscription the template declares inline was created `PendingConfirmation` on
  2026-08-08, was never confirmed, and SNS deleted it after about three days,
  reading as absent rather than pending so a naive check saw a healthy topic.
  **Check the attribute with `aws sns get-subscription-attributes`, not the row**;
  an `email` row in `list-subscriptions-by-topic` is what looked healthy before.
  Confirming it by clicking the link in the email produced a confirmation and a
  deactivation timestamped the same minute: SNS unsubscribe is an unauthenticated
  GET, so a browser prefetch or mail scanner fires it. It was re-created with
  `aws sns subscribe` and confirmed with `aws sns confirm-subscription
  --authenticate-on-unsubscribe true`, which makes unsubscribing require a
  signed request. That flag is settable only at confirmation time. Budget
  notifications were never affected: Budgets' EMAIL subscribers have no
  confirmation handshake.
  **A redeploy would not have fixed it**: the subscription is inline on the topic,
  `AlertEmail` is unchanged, so CloudFormation puts the topic in no changeset.
  Drift detection reports it `MODIFIED` / `/Subscription/0` `REMOVE`d and does not
  remediate.
- **The AWS CLI and SAM CLI are installed here and credentials are live and
  admin-level.** `sam validate --lint` passes against `template.yaml`, and
  read-only `aws` calls work. This means a deploy is *possible* from this
  environment, so do not run one unless asked. Note especially the README's
  warning: never `sam deploy` your way out of a fired kill switch, since it
  silently resets concurrency and reopens the endpoint.
- The real Bedrock path has been exercised in production (invocations logged
  2026-08-08/09, 1.3-2.7s, no Bedrock errors). The alarm → SNS → kill-switch
  chain has now been exercised as well: the drill passed on **2026-08-22**, both
  halves. See "Kill-switch drill" below for what that does and does not prove.

## History

`bench-extract` was split out of `vue-simostack` with `git-filter-repo`, so
pre-split commits are the originals and their messages describe paths under
`lambda/bench-extract/`. Blame and log work; those paths don't resolve here.

## Known coupling (unenforced, documented only)

`bench-extract/index.mjs` is the request/response contract, and its consumer is
`src/components/bench/AddListingFlow.vue` in `vue-simostack`. Nothing tests that
they agree across the repo boundary, so a contract change here is half a change
until that file is updated.

Also carried by hand across that boundary: the Function URL and access token,
set as GitHub Actions secrets on `vue-simostack` and in its local `.env`
(`VITE_BENCH_EXTRACT_URL`, `VITE_BENCH_ACCESS_TOKEN`). A stale URL doesn't
error: the site calls the old one and every extraction fails as a network error
that reads like a Lambda fault.

## bench-auth (Phase 1 authored, nothing deployed)

Replaces the shared `x-bench-token` header (checked in
`bench-extract/index.mjs`, ~line 153, against an SSM-sourced env var) with
Cognito. That token ships in the public JS bundle and was never a secret.

Work through the design checklist in `SECURITY.md` before extending any of this.

### The load-bearing constraint

**The Lambda stays the only thing that calls Bedrock.** The authenticated
Identity Pool role gets `lambda:InvokeFunctionUrl` on the one function ARN and
nothing else. It must never get `bedrock:InvokeModel`.

This is not a style preference. Three of the four spend layers are properties
of the Lambda or its role, and handing browsers Bedrock credentials silently
removes all three:

| Layer | Mechanism | Survives direct-to-Bedrock? |
| --- | --- | --- |
| Bedrock service quota | Account-level, synchronous | Yes |
| `ReservedConcurrentExecutions` | Lambda config | **No** |
| Alarm → SNS → kill switch | Zeroes *that Lambda's* concurrency | **No** |
| Budget → deny policy | Attached to `BenchExtractFunctionRole` | **No** |

`BenchDenyBedrockPolicy` is attached by `BenchBudgetAction` to exactly one role:
its `Roles:` list names only `BenchExtractFunctionRole`. Route spend around
that role and the enforcement budget still *notices* it but no longer *stops*
it. So if a future change ever does grant a second principal direct Bedrock
access, that principal must be added to the `Roles:` list in the same change.

If you are about to propose issuing Bedrock credentials to the browser: that was
considered and rejected for the reason above. Don't re-derive it.

### Settled decisions

- Open self-service sign-up via Google federation. No approval gate, no
  pre-sign-up allowlist trigger.
- Authorization via Identity Pool + IAM role, not application-layer logic. This
  is the point of the project, not just adding a login screen.
- Global caps only, no per-user spend limits in the Lambda. Expected scale is
  under 5 users; 10 is the revisit point.
- Function URL moves `AuthType: NONE` → `AWS_IAM`. Hard cutover, no alias or
  dual-URL transition; the breakage window is acceptable at this scale.
- `ReservedConcurrentExecutions` goes 1 → 2, because a second concurrent user
  currently gets a 429. The >100-invocations/5min alarm threshold stays where it
  is: with no per-user quota, that global breaker is the only fast defence.
- Log the Cognito sub on every invocation even though per-user quotas are
  deferred. It costs nothing, it tells you *who* when the alarm fires, and it
  means quotas can be added later without a second cutover.

**Consequence of open sign-up + global caps:** anyone with a Google account can
sign up and spend the Bedrock budget. That is accepted, but it makes
`BudgetMonthlyLimitUsd` the actual security boundary rather than a placeholder.

### Phases

1. **bench-auth standalone**: User Pool, Google IdP, User Pool client, Identity
   Pool, authenticated role. Deploys and verifies without touching
   bench-extract. *Authored, not deployed.*
2. **bench-extract cutover**: `AuthType: AWS_IAM`; drop the token check;
   `Cors.AllowHeaders` loses `x-bench-token` and gains the SigV4 headers; read
   identity from `requestContext.authorizer.iam.cognitoIdentity`; concurrency to
   2. A Function URL cannot serve both auth modes at once, so there is a
   breakage window between this and Phase 3. Two checks are part of the phase,
   not optional extras: the changeset must show the `AWS::Lambda::Permission`
   from the `AuthType: NONE` URL (`Principal: *`) being replaced, and after the
   deploy an unsigned call to the Function URL must return 403.
3. **vue-simostack**: login UI, SigV4 signing on the call, retire
   `VITE_BENCH_ACCESS_TOKEN`. **Entry gate:** the User Pool's
   `DeletionProtection` goes `INACTIVE` → `ACTIVE`, deployed, before the login
   UI ships. `INACTIVE` is correct through Phases 1-2; shipping login is when
   the pool starts holding real users.
4. **Recalibrate and update `SECURITY.md`**: "the shared token is not
   authentication" closes; "open sign-up means anyone can spend the budget"
   opens in its place.

### Kill-switch drill (last passed 2026-08-22)

The alarm → SNS → kill-switch chain **has** now fired, under the "Testing the
kill switch" drill in `bench-extract/README.md`. Both halves passed: reserved
concurrency went to 0, and the email arrived. **This was the stated gate on
opening sign-up, and it is now cleared.** Recorded so the next reader does not
re-derive it:

- Forced `OK` → `ALARM` at 07:27:44Z; SNS fanned out to both subscribers; the
  kill-switch Lambda ran in 870ms and zeroed concurrency.
- The alarm self-cleared to `OK` at 07:28:47Z, 63 seconds later, on the missing
  datapoint being treated as `NonBreaching`. It does not sit latched, so the next
  real trip still has a transition to fire on. `OKActions` is `[]`, so recovery
  fires nothing.
- Reserved concurrency was restored to 1 by hand. Total outage: 48 seconds.

**What this does not prove:** the drill forces the transition with
`set-alarm-state`, so everything from `ALARM` onward is verified while the
`Invocations` metric, the `FunctionName` dimension, the 300-second period and the
threshold of 100 are still taken on trust. The honest claim is "the chain fires
correctly once the alarm fires", not "the alarm fires at the right time".

**Re-run it quarterly** (next due **2026-11-22**), and off-cycle after any deploy
that recreates the SNS topic or changes the alarm, since a recreated topic starts
with an unconfirmed email subscription on a three-day fuse.

When re-running: assert the email subscription's `ConfirmationWasAuthenticated:
true` rather than just its row, and check **both** halves. Do not invoke the
kill-switch Lambda directly. It publishes nothing, so that tests the concurrency
half and silently skips the notification half, which is the failure this drill
exists to catch. This is a live-resource change and a real outage, so ask first.
