# DEPLOYED.md: live state and verification record

What is actually deployed, what was verified and when. Split out of
`CLAUDE.md` so that file can stay conventions only. Everything here carries a
date and goes stale; `CLAUDE.md` does not.

Live-resource changes are a manual gate. See `~/.claude/CLAUDE.md`.

## Deployed state (bench-extract verified 2026-08-29, bench-auth 2026-08-27)

- The bench-extract stack is deployed in **`ap-southeast-2` under the stack name
  `sam-app`**, the `--guided` default, never changed. There is no stack named
  `bench-extract`; looking for one and concluding nothing is deployed is the
  easy mistake. The Lambda itself is `bench-extract`.
- Reserved concurrency is **2**, matching the template; it went 1 -> 2 at the
  Phase 2 cutover, not in Phase 4 as the phase list once implied. Read it with
  `aws lambda get-function-concurrency` -- `get-function-configuration` does
  **not** return the field, and its absence there is indistinguishable from no
  reserved concurrency at all, i.e. from the kill switch's layer being gone.
  `bench-extract-high-invocations`
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
  read-only `aws` calls work. Note especially the README's warning: never
  `sam deploy` your way out of a fired kill switch, since it silently resets
  concurrency and reopens the endpoint.
- The real Bedrock path has been exercised in production (invocations logged
  2026-08-08/09, 1.3-2.7s, no Bedrock errors). The alarm → SNS → kill-switch
  chain has now been exercised as well: the drill passed on **2026-08-22**, both
  halves. See "Kill-switch drill" below for what that does and does not prove.

### bench-auth (deployed 2026-08-25)

- Stack name is **`bench-auth`** in `ap-southeast-2`, not the `sam-app` default
  that bench-extract landed under. Resource ids, all from stack outputs:
  User Pool `ap-southeast-2_eDQvUrDb3` (`bench-users`), client
  `7omtia4riv4qnpqs4bdtmv5e6i` (public, no secret), hosted UI domain
  `bench-simostack`, Identity Pool `ap-southeast-2:968e7518-...`, authenticated
  role `bench-auth-BenchAuthenticatedRole-kRh9rK92LgGw`.
- `AllowUnauthenticatedIdentities` is **false**, so there is no unauthenticated
  role to reason about. Only the authenticated role exists.
- The User Pool client allows the `code` flow only; `ExplicitAuthFlows` is
  `ALLOW_REFRESH_TOKEN_AUTH` alone. There is no password auth flow, so a
  federated user's credentials **cannot** be re-obtained headlessly: every
  verification run needs a real browser sign-in.
- `DeletionProtection` is **`ACTIVE`** as of 2026-08-30, when the Phase 3 entry
  gate was cleared (in-place update, no replacement). It was `INACTIVE` through
  Phases 1-2. Tearing this stack down now means flipping it back to `INACTIVE`
  and deploying that change first.
- The authenticated role carries exactly two inline policies and no attached
  ones: `invoke-bench-extract-function-url` (`lambda:InvokeFunctionUrl` on the
  single bench-extract ARN, conditioned on `lambda:FunctionUrlAuthType` being
  `AWS_IAM`) and `never-bedrock` (`Deny bedrock:* on *`).

### Phase 1 verification (2026-08-27)

`bench-auth/verify-e2e.sh` is the check, and it resolves every id from stack
outputs rather than hardcoding them. Its step 5 is phase-aware: it reads the
live Function URL `AuthType` and asserts the posture that phase requires, so it
is also the Phase 2 cutover check and needs no editing at that deploy.

Run end-to-end against real resources with a real Google sign-in, not simulated.
What it established:

- The hosted UI + Google IdP complete a PKCE authorization-code flow, the
  Identity Pool exchanges the `id_token`, and the resulting credentials are
  `assumed-role/bench-auth-BenchAuthenticatedRole-.../CognitoIdentityCredentials`.
  The Bedrock probes ran with the admin identity scrubbed from the environment,
  so a pass could not have been the admin credentials leaking through.
- `bedrock:ListFoundationModels` was **denied live** under those credentials.
- `lambda:GetFunction` was denied, confirming the role is not broader than the
  two policies above.
- The first Cognito user now exists: `Google_101148087223423648620`,
  `EXTERNAL_PROVIDER`. Sign-up works; it is the pool's only user.

`bedrock:InvokeModel` was **not** exercised live in the 2026-08-27 run: the CLI
rejected the request body client-side (AWS CLI v2 wants
`--cli-binary-format raw-in-base64-out`), so no call reached Bedrock. **That gap
is closed as of the 2026-08-29 run**, which passed step 4 with the flag in place
and the call genuinely refused by Bedrock, so the live claim now holds for
`InvokeModel` as well as `ListFoundationModels`. The reasoning below is kept
because it is why the script now fails loudly on a client-side rejection instead
of counting it as a pass. `simulate-principal-policy` returns `explicitDeny` for
`InvokeModel`, `InvokeModelWithResponseStream`, `Converse` and
`CreateModelCustomizationJob`, against both the foundation-model ARN and the
`au.*` inference-profile ARN the Lambda actually uses. That is the same `Deny
bedrock:*` statement that was proven live by `ListFoundationModels`, so the gap
is narrow, but the honest claim is "denied by policy evaluation", not "a live
InvokeModel call was refused".

The same simulation returns `allowed` for `lambda:InvokeFunctionUrl` on
bench-extract when `lambda:FunctionUrlAuthType` is `AWS_IAM`, so the Phase 2
cutover has the grant it needs. Today that call is denied in practice, because
the Function URL is still `AuthType: NONE` and the grant's condition does not
match. **A denied signed call to the Function URL is expected before Phase 2 and
is not a regression.** That sentence describes the world before 2026-08-29; the
Function URL is now `AWS_IAM` and the signed call is the one that works.

### Phase 2 cutover (deployed 2026-08-29)

The auth half landed and is verified live:

- `aws lambda get-function-url-config` reads `AuthType: AWS_IAM`.
- `aws lambda get-policy` returns **no policy at all**, so both `Principal: "*"`
  permissions are gone. That is the cutover gate met, not merely a changeset
  that looked right.
- An unsigned POST returns 403 and is not an invocation. A signed POST from the
  bench-auth authenticated role reaches the handler.

**The identity half shipped broken and was found the same day.** The handler
read `requestContext.authorizer.iam.cognitoIdentity`, which Lambda documents as
never populated on a Function URL, so the live log line read
`{"identityId":null,"userPoolSub":null}` on a genuine authenticated call. The
unit tests passed because they asserted against a hand-built API-Gateway-shaped
event this endpoint cannot emit, and `verify-e2e.sh` passed 9/9 because nothing
in it looked at the log line.

**Fixed, deployed and verified the same day.** The handler reads the caller's
id_token from the `x-bench-id-token` header and verifies it against the pool's
JWKS (`aws-jwt-verify`), failing closed with a 401. `verify-e2e.sh` reported
**12/12 on 2026-08-29**, with its new step 6 establishing all three of:

- the logged `userPoolSub` is exactly the `sub` claim of the id_token that made
  that call, correlated by `x-amzn-RequestId` rather than by recency;
- a signed call carrying no `x-bench-id-token` returns 401, so the gate closes
  rather than merely being present;
- `sam-app`'s `UserPoolId` parameter still matches the pool `bench-auth`
  deploys. A pool recreated on one side without the other is a total, silent
  401 outage, and both stacks read as correctly configured on their own.

The pool and client reach bench-extract as the plain template parameters
`UserPoolId` and `UserPoolClientId`, set in `samconfig.toml`, deliberately not
as a cross-stack `ImportValue`. **They have no defaults**: a deploy that has not
been told which pool to trust fails at the prompt instead of coming up trusting
the wrong one, so adding them to an existing deployment means hand-editing
`parameter_overrides`, never re-running `--guided`.

**Reading CloudWatch for that log line: quote the filter pattern.**

```bash
aws logs tail /aws/lambda/bench-extract --since 10m --region ap-southeast-2 \
  --filter-pattern '"bench-extract invocation"'
```

Unquoted, `--filter-pattern 'bench-extract invocation'` matches **zero** events
against a log group that plainly contains the line -- the hyphen is significant
in an unquoted CloudWatch term. The failure is silent and reads exactly like
"the handler never logged", which is how it nearly hid the defect above rather
than exposing it.

## Phases

1. **bench-auth standalone**: User Pool, Google IdP, User Pool client, Identity
   Pool, authenticated role. Deploys and verifies without touching
   bench-extract. **Deployed 2026-08-25, verified end-to-end 2026-08-27** (see
   "Phase 1 verification" below).
2. **bench-extract cutover**: `AuthType: AWS_IAM`; drop the token check;
   `Cors.AllowHeaders` loses `x-bench-token` and gains the SigV4 headers plus
   `x-bench-id-token`; verify the caller's Cognito id_token and log its `sub`;
   concurrency to 2. A Function URL cannot serve both auth modes at once, so
   there is a breakage window between this and Phase 3. Three checks are part
   of the phase, not optional extras: the changeset must show **both**
   `Principal: "*"` permissions on the function going away (there are two live
   before the cutover, the `InvokeFunctionUrl`/`AuthType: NONE` one and the
   `InvokeFunction`/`InvokedViaFunctionUrl` one), after the deploy an unsigned
   call to the Function URL must return 403, and `verify-e2e.sh` step 6 must
   read a real `userPoolSub` back out of the log line.

   **Identity does not come from the IAM request context, and cannot.** The
   first cut of this phase read
   `requestContext.authorizer.iam.cognitoIdentity`; Lambda documents that field
   as never populated on a Function URL ("Function URLs don't use this
   parameter"), so it logged `null` on every invocation while its unit tests
   stayed green. Cognito's enhanced flow also gives every user of the role the
   same assumed-role session name, so `userArn` and `userId` are identical
   across users and are no substitute. The caller sends its id_token in the
   `x-bench-id-token` header instead and the handler verifies it against the
   pool's JWKS with `aws-jwt-verify`. Don't re-derive this; it cost a deploy.

   **Deployed and verified end-to-end 2026-08-29** (`verify-e2e.sh`, 12/12).
   See "Phase 2 cutover" above.
3. **vue-simostack**: login UI, SigV4 signing on the call, retire
   `VITE_BENCH_ACCESS_TOKEN`. **Set `x-bench-id-token` before the request is
   signed**, not in a fetch interceptor afterwards: set first, it lands in
   `SignedHeaders` and the signature is bound to it; added after, it still
   arrives and still verifies, but nothing ties it to that request. The
   id_token is the same one already exchanged for the SigV4 credentials, so
   take both from a single refresh rather than caching them separately --
   pairing fresh credentials with a stale token is the failure mode.
   **Entry gate cleared 2026-08-30:** the User Pool's `DeletionProtection` is
   `ACTIVE`, deployed as an in-place update with no replacement. `INACTIVE` was
   correct through Phases 1-2; shipping login is when the pool starts holding
   real users.

   **Shipped and verified live.** The frontend signs with `aws4fetch` and a
   hand-rolled PKCE flow, no AWS SDK. Confirmed from this side rather than
   taken on report: `/aws/lambda/bench-extract` carries invocations on
   2026-08-30 logging a real non-null `userPoolSub`, where the same log line on
   2026-08-29 read `null`. Retiring `VITE_BENCH_ACCESS_TOKEN` from the frontend
   `.env` and the GitHub Actions secrets is the tail of this phase and was in
   flight on 2026-09-01; completion of that frontend housekeeping has not been
   checked here as of 2026-09-13.
4. **Retire the shared token outright and recalibrate `SECURITY.md`**: drop the
   `BenchAccessTokenParameterName` parameter and the `BENCH_ACCESS_TOKEN`
   environment variable, cut the access-token and rotation sections from
   `bench-extract/README.md`, delete the `/bench/access-token` SSM parameter,
   and rewrite the `SECURITY.md` entry -- "the shared token is not
   authentication" closes, "open sign-up means anyone with a Google account can
   spend the budget" opens in its place. **Authored 2026-09-01; deployed and
   verified 2026-09-13, including separate SSM deletion.** The concurrency
   1 -> 2 recalibration once listed here already landed with Phase 2.

   **Deployed 2026-09-13:** `sam-app` is `UPDATE_COMPLETE`, the live Lambda no
   longer carries the environment variable, and the stack no longer takes the
   token parameter. The user separately deleted the SSM parameter; a read-only
   metadata check confirmed no match. `AWS_IAM` and the Function URL remain
   unchanged. The browser-based end-to-end suite was not rerun that day.

## Kill-switch drill (last passed 2026-08-22)

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
exists to catch. This is a live-resource change and a real outage.
