# bench-auth

Cognito authentication for Bench: a User Pool with Google federation, an
Identity Pool, and an authenticated IAM role scoped to invoking the
bench-extract Function URL.

**Authentication phases 1–4 are complete.** Phase 1 deployed
2026-08-25 and verified 2026-08-27, as the stack `bench-auth` in
`ap-southeast-2`; Phase 2 -- the bench-extract cutover to `AuthType: AWS_IAM`
with id_token attribution -- deployed and verified 2026-08-29, `verify-e2e.sh`
12/12. Phase 3 shipped the frontend Google login and SigV4 signing; the User
Pool's `DeletionProtection: ACTIVE` was deployed on 2026-08-30. Phase 4's
shared-token cleanup was deployed and checked on 2026-09-13, including
deletion of the obsolete SSM parameter. This does not mean listing scoring or
URL import is complete. See [the Bench roadmap](../BENCH-ROADMAP.md) for
product status and next milestones, and "Verifying" below for the auth checks.

## What this replaces

Bench used to authenticate with a single shared access token
(`VITE_BENCH_ACCESS_TOKEN`), inlined into the public JS bundle and therefore
readable by anyone who loaded the site. It was not a secret and was never
treated as one. **That is done: the handler stopped reading it at the Phase 2
cutover on 2026-08-29, and Phase 4 retired the parameter and the environment
variable in code on 2026-09-01 and in AWS on 2026-09-13** -- see
"Access token (retired in Phase 4)" in
[`../bench-extract/README.md`](../bench-extract/README.md), kept there for why
it has no rotation successor.

Replacing it does not change what bounds abuse, and that is the point worth
holding onto: spend is bounded by the Bedrock quota, reserved concurrency, the
kill switch and the budget action, and it was bounded by exactly those before
this service existed. Authentication was never one of the layers. With open
sign-up it still isn't -- anyone with a Google account can now obtain a valid
identity, so the budget cap is doing the work the token never did. Those
guardrails and the threat model behind them are in
[`../SECURITY.md`](../SECURITY.md), which this service is expected to satisfy
rather than replace.

## The constraint this service exists to hold

**The Lambda stays the only thing that calls Bedrock.** The authenticated
Identity Pool role gets `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`
on the one function ARN, restricted to the IAM-authenticated Function URL.
It never gets `bedrock:InvokeModel`.

This is the reason the design looks the way it does. Three of the four layers
bounding Bedrock spend are properties of the bench-extract function or its
execution role:

| Layer                          | Mechanism                                  | Survives direct-to-Bedrock? |
| ------------------------------ | ------------------------------------------ | --------------------------- |
| Bedrock service quota          | Account-level, synchronous                 | Yes                         |
| `ReservedConcurrentExecutions` | Lambda config                              | **No**                      |
| Alarm → SNS → kill switch      | Zeroes *that Lambda's* concurrency         | **No**                      |
| Budget → deny policy           | Attached to `BenchExtractFunctionRole`     | **No**                      |

`BenchDenyBedrockPolicy` is attached by `BenchBudgetAction` to exactly one role:
its `Roles:` list names only `BenchExtractFunctionRole`. Issuing Bedrock
credentials to the browser routes spend around all three layers and leaves the
enforcement budget attached to a role nobody is using. It would look like it
still worked, right up until it needed to work.

If a future change ever does grant a second principal direct Bedrock access,
that principal must be added to the `Roles:` list in
`../bench-extract/template.yaml` in the same change.

## Decisions

Settled. Flag it if something in the codebase contradicts one of these, but they
do not need re-deriving.

- **Open self-service sign-up** via Google federation. No approval gate, no
  pre-sign-up allowlist trigger.
- **Authorization via Identity Pool + IAM role**, not application-layer logic.
  This is the point of the project, not just adding a login screen.
- **Global caps only**: no per-user spend limits in the Lambda. Expected scale
  is under 5 users; 10 is the point to revisit.
- **Function URL moves `AuthType: NONE` → `AWS_IAM`** in Phase 2. Hard cutover,
  no alias or dual-URL transition; the breakage window is acceptable here.
- **`ReservedConcurrentExecutions` goes 1 → 2**, because a second concurrent
  user currently gets a 429. The >100-invocations/5min alarm threshold stays
  where it is: with no per-user quota, that global breaker is the only fast
  defence.
- **Log the Cognito sub on every invocation**, even though per-user quotas are
  deferred. It costs nothing, it tells you *who* when the alarm fires, and it
  means quotas can be added later without a second cutover.

Open sign-up plus global caps means anyone with a Google account can sign up and
spend the Bedrock budget. That is accepted, and it is why
`BudgetMonthlyLimitUsd` on the bench-extract stack is the real security
boundary rather than a placeholder.

## Phases

1. **bench-auth standalone**: everything in this directory. Deploys and
   verifies without touching bench-extract. *Deployed 2026-08-25, verified
   2026-08-27 with `verify-e2e.sh`.*
2. **bench-extract cutover**: `AuthType: AWS_IAM`, drop the token check,
   `Cors.AllowHeaders` loses `x-bench-token` and gains the SigV4 headers plus
   `x-bench-id-token`, verify the caller's id_token and log its `sub`,
   concurrency to 2. A Function URL cannot serve both auth modes at once, so
   there is a breakage window between this and Phase 3. *Deployed and verified
   2026-08-29 with `verify-e2e.sh`, 12/12.*
   - [x] **Confirm the cutover actually closed the URL**, both halves: the
     changeset before executing it, and an unsigned `curl` after. See
     "Phase 2 checklist" below, which is the full step-by-step. `get-policy`
     returns no policy at all, so both `Principal: "*"` permissions are gone.
   - [x] **Confirm the Lambda can say who called it**, which is a separate
     question from whether the URL is closed. `requestContext.authorizer.iam.cognitoIdentity`
     is *not* the answer: Lambda documents it as never populated on a Function
     URL, and the first cut of this phase shipped reading it and logged a null
     sub on every real call. The caller sends its id_token in
     `x-bench-id-token` instead. `verify-e2e.sh` step 6 is the check, and it
     now reads the logged sub back and matches it against the token's own.
3. **vue-simostack**: login UI, SigV4 signing on the call, retire
   `VITE_BENCH_ACCESS_TOKEN` from the request path. **Shipped and verified live
   before Phase 4 was authored on 2026-09-01.** See "Phase 3 checklist" below
   for the signing procedure. Old frontend environment/Actions-secret cleanup
   was previously recorded as in flight; its completion has not been checked
   in this repo and is not required for authentication to work.
   - [x] **Entry gate, cleared 2026-08-30:** `DeletionProtection` on the User
     Pool went `INACTIVE` → `ACTIVE` and was deployed as an in-place update,
     no replacement. `INACTIVE` was the right setting through Phases 1 and 2,
     while the pool held only test accounts and might need tearing down;
     shipping the login UI is the moment it starts holding real users, and
     deleting a user pool deletes its users unrecoverably.
4. **Retire the shared token and update `SECURITY.md`**: remove the template
   parameter, Lambda environment variable, and `/bench/access-token` SSM
   parameter. **Authored 2026-09-01; deployed and verified 2026-09-13.**
   `sam-app` is `UPDATE_COMPLETE`, the token parameter and environment variable
   are absent, and an SSM metadata lookup returns no matching parameter.
   `AWS_IAM` and the Function URL are unchanged. Open Google sign-up still
   allows any signed-in user to spend the shared budget.

These are the completed authentication phases. Proposed product milestones
continue in [BENCH-ROADMAP.md](../BENCH-ROADMAP.md).

## Phase 2 checklist

Phase 2 edits `../bench-extract/`, not this directory, but it is bench-auth work
and the checklist lives here. Steps are lettered so they can be referred to:
A is read-only and can be run at any time, B is the change, C is what proves it.

**Completed 2026-08-29.** The boxes below are left unticked on purpose: this is
the procedure, not the record of one run. What the run established is in
`../CLAUDE.md` under "Phase 2 cutover", including the one item that failed the
first time -- identity logging, which shipped reading a field a Function URL
never populates and needed a second deploy.

### A. Pre-deploy check

Establish the before state, so the after state means something. All read-only.

- [ ] The Function URL is still open:
      `aws lambda get-function-url-config --function-name bench-extract
      --region ap-southeast-2 --query AuthType` returns `NONE`.
- [ ] **Both** `Principal: "*"` statements are on the function policy. There are
      two today, not one (verified 2026-08-23 via `aws lambda get-policy`), and
      step C asserts both are gone:
      - `...BenchExtractFunctionUrlPublicPermissions...` --
        `lambda:InvokeFunctionUrl`, conditioned on
        `lambda:FunctionUrlAuthType: NONE`.
      - `...BenchExtractFunctionURLInvokeAllowPublicAccess...` --
        `lambda:InvokeFunction`, conditioned on
        `lambda:InvokedViaFunctionUrl: true`.
- [ ] `ReservedConcurrentExecutions` reads 1, matching the template. If it reads
      0 the kill switch is tripped, and deploying is exactly the wrong move:
      see the un-trip procedure in `../bench-extract/README.md`.
- [ ] `bench-extract-high-invocations` is in `OK`, and its SNS email
      subscription reports `ConfirmationWasAuthenticated: true` (the attribute,
      not the row). Concurrency is about to double, and that alarm is the only
      fast defence left once per-user quotas are deferred.

### B. The deploy

In `../bench-extract/template.yaml`:

- [ ] `FunctionUrlConfig.AuthType`: `NONE` to `AWS_IAM`.
- [ ] `Cors.AllowHeaders`: drop `x-bench-token`, add the SigV4 headers
      (`authorization`, `x-amz-date`, `x-amz-security-token`,
      `x-amz-content-sha256`). Keep `content-type`.
- [ ] `ReservedConcurrentExecutions`: 1 to 2.
- [ ] Update the header comment at the top of the file. It currently explains
      `AuthType: NONE` as deliberate, which stops being true here.
- [ ] Leave `BenchAccessTokenParameterName` and the `BENCH_ACCESS_TOKEN`
      environment variable in place. See step D.

In `../bench-extract/index.mjs`:

- [ ] Drop the `x-bench-token` check at the top of the handler (~line 153).
      With `AWS_IAM` the request never reaches the handler unsigned, so the
      check is not a second layer, it is a 401 for every legitimate caller.
- [ ] Read the caller from `event.requestContext.authorizer.iam.cognitoIdentity`
      and log it on every invocation: `identityId` is the Identity Pool
      identity, and the User Pool sub arrives in the `amr` array as
      `<user-pool-id>:CognitoSignIn:<sub>`. This is the "log the sub" decision
      above; it is what makes per-user quotas addable later without a second
      cutover.
- [ ] Update the vitest tests that assert the 401 on a missing or wrong token.
      They will fail, and they should: that contract is being removed.

In `template.yaml` (this directory -- the checklist originally missed this and
the cutover failed its first verification because of it):

- [ ] The authenticated role's `invoke-bench-extract-function-url` policy needs
      **two** statements, not one: `lambda:InvokeFunctionUrl` conditioned on
      `lambda:FunctionUrlAuthType: AWS_IAM`, **and** `lambda:InvokeFunction`
      conditioned on `lambda:InvokedViaFunctionUrl: true`. Since October 2025 a
      function URL requires the caller to hold both. Before the cutover this
      role got away with the first alone, because bench-extract's resource-based
      policy granted `lambda:InvokeFunction` to `Principal: "*"` for the
      `AuthType: NONE` URL -- the very statement step C asserts is gone. Closing
      the URL therefore removes a permission the role was silently relying on.
- [ ] This is a **separate deploy of the `bench-auth` stack**, and there is no
      `samconfig.toml` here, so parameters are passed on the command line and
      `GoogleClientSecret` has to be supplied again (it is `NoEcho`, so it
      cannot be read back off the deployed stack). See "Deploying" below.

Then, before executing anything:

- [ ] `sam build && sam deploy --no-execute-changeset` in `../bench-extract`,
      and **read the changeset**. Both `AWS::Lambda::Permission` resources from step A must
      show as removed. Changing `AuthType` while leaving a permission behind
      reads as a successful cutover while the endpoint is still open to anyone.

### C. Post-deploy verification

- [ ] An unsigned `curl -si -X POST <function-url>` returns `403`. This is the
      one check that cannot pass by reading configuration back to itself.
- [ ] `aws lambda get-policy` returns neither `Principal: "*"` Sid.
- [ ] `ReservedConcurrentExecutions` reads 2.
- [ ] `bash bench-auth/verify-e2e.sh`. Step 5 reads the live `AuthType` and
      switches to the `AWS_IAM` row by itself, so there is nothing to edit: it
      asserts the unsigned 403 and that a signed call authenticates.
- [ ] `verify-e2e.sh` step 6 reports the logged `userPoolSub` matching the sub
      in the id_token that made the call, and a signed call without the header
      returning 401. This was a manual "check CloudWatch, confirm it isn't
      null" item, and it is automated now because the manual version is what
      caught the defect too late: the handler read
      `requestContext.authorizer.iam.cognitoIdentity`, which a Function URL
      never populates, so it logged a null sub on every real invocation while
      the unit tests and steps 1-5 all stayed green.
- [ ] If you are reading the log by hand, **quote the filter pattern**:
      `--filter-pattern '"bench-extract invocation"'`. Unquoted it matches zero
      events -- the hyphen is significant in an unquoted CloudWatch term -- and
      an empty result is indistinguishable from the handler never having
      logged.

**Reading a 403 on the signed call:** Lambda answers a missing invoke
permission with a bare 403, byte-identical to the one an unsigned request gets,
so step 5 failing tells you the call was refused but not why. Do not conclude
the cutover is wrong. `simulate-principal-policy` is not sufficient either: it
evaluates identity policies only, cannot see the function's resource-based
policy, and will report `allowed` for `lambda:InvokeFunctionUrl` while the call
fails for want of `lambda:InvokeFunction`. Simulate **both** actions.

Historically, between this cutover and Phase 3 shipping, the frontend still
sent `x-bench-token` and received a 403 on every extraction. That accepted
breakage window is now closed.

### D. What does not change in Phase 2: the access token

- [ ] Leave the `/bench/access-token` SSM parameter, the
      `BenchAccessTokenParameterName` template parameter and the
      `BENCH_ACCESS_TOKEN` environment variable in place. The handler stops
      reading the header, but leaving the parameter wired keeps a rollback to
      the previous template a single deploy rather than a re-seed, and the
      parameter costs nothing to hold.
- [ ] Leave `VITE_BENCH_ACCESS_TOKEN` in `vue-simostack` alone. Phase 3 retires
      it there, when the login UI replaces it.
- [ ] **Retire in Phase 4**, not before: delete the template parameter, the
      environment variable and the SSM parameter itself, and cut the access
      token and rotation sections from `../bench-extract/README.md`, in the same
      change that recalibrates `SECURITY.md`. **The SSM parameter is a separate
      step from that deploy**, and the ordering is the point: an
      `AWS::SSM::Parameter::Value<String>` is a deploy-time lookup rather than a
      stack resource, so dropping it from the template does not delete it, and
      rollback stays a single deploy for exactly as long as it is left in place.
      Delete it last, once you are confident there is no rollback.
      (Phase 4 was authored on 2026-09-01 and completed on 2026-09-13.)

## Phase 3 checklist

Phase 3 is work in `vue-simostack`, not here, but the constraints it has to
meet are properties of what this repo deployed, so they are written down here
rather than rediscovered there.

**The login and signing implementation has shipped.** Like Phase 2's checklist,
the unticked boxes below preserve a procedure, not an implementation backlog.
Removal of any unused frontend environment/Actions secret remains unverified.

### Entry gate, before any login UI ships -- cleared 2026-08-30

- [x] `DeletionProtection` on the User Pool is `ACTIVE`, deployed in place with
      no replacement. `INACTIVE` was right through Phases 1 and 2, while the
      pool held only test accounts; shipping login is the moment it starts
      holding real users, and deleting a user pool deletes its users
      unrecoverably. The frontend login and signing work subsequently shipped.

### Signing the call

- [ ] Sign every request to the Function URL with SigV4, using the credentials
      from `GetCredentialsForIdentity`. Service name is `lambda`, region
      `ap-southeast-2`.
- [ ] **Set `x-bench-id-token` BEFORE the request is signed, not in a fetch
      interceptor afterwards.** This is the one ordering requirement, and
      getting it wrong is invisible from the response: a header added after
      signing still arrives and still verifies, so the call succeeds and the
      sub is logged correctly. What is lost is silent -- the header is not in
      `SignedHeaders`, so the signature no longer covers it and nothing binds
      that identity claim to that request. Set it first and it is signed with
      everything else.
- [ ] The id_token to send is the one already being exchanged for those
      credentials. There is no second token to fetch and no new secret.
- [ ] **Take the credentials and the id_token from the same refresh.** Both
      expire in about an hour and both come out of the same refresh-token
      round trip. Cached separately they drift, and fresh credentials paired
      with an expired token is a 401 that looks like a signing bug.
- [ ] Handle 401 distinctly from 403. 403 is IAM refusing the call (not signed,
      or the role lacks the grant). 401 is the handler refusing to attribute it
      (no `x-bench-id-token`, or the token is expired, or it is for the wrong
      pool or client). They have completely different fixes.

### Values Phase 3 needs

All from this stack's outputs; nothing carries them across automatically, the
same as the Function URL handoff.

- [ ] `UserPoolId`, `UserPoolClientId`, `IdentityPoolId`, `HostedUiDomain`.
- [ ] The bench-extract Function URL, unchanged by the cutover.
- [ ] Retire `VITE_BENCH_ACCESS_TOKEN` from the local `.env` and the GitHub
      Actions secrets once the login flow replaces it. In flight as of
      2026-09-01. Nothing is blocked on it in either direction: the handler has
      not read the header since 2026-08-29, and the infra side of the retirement
      (Phase 4) was deployed on 2026-09-13 regardless of when this lands.

### CORS

- [ ] Nothing to change here if the site stays on the origins already listed in
      `bench-extract/template.yaml` (`simostack.com`, `www.simostack.com`, and
      the two localhost dev ports). `x-bench-id-token` is already in
      `AllowHeaders` -- a missing entry there fails the preflight, so the
      symptom is a CORS error in the browser console and no invocation at all,
      not a 401.

## By-hand prerequisites: Google Cloud Console

None of this is expressible in CloudFormation, and all of it must be done before
the first deploy. The stack creates the Google IdP with the credentials you
supply, and **that resource fails to create if the credentials are not already
valid**.

### The ordering problem

Google needs a redirect URI that points at the Cognito hosted-UI domain, and the
Cognito domain does not exist until this stack is deployed. The way out is that
the URI is fully determined by the domain prefix you choose, so you can write it
down before anything exists:

```
https://<CognitoDomainPrefix>.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse
```

Pick the prefix first, use it in step 5 below, then pass the same value as
`CognitoDomainPrefix` at deploy time. It must be globally unique across all AWS
accounts, so choose something specific: `bench-simostack`, not `bench`. The
stack outputs `GoogleRedirectUri` so you can confirm the two agree after
deploying.

### Checklist

1. **Create or select a Google Cloud project** at
   <https://console.cloud.google.com/>. A dedicated project is easier to reason
   about later than reusing an unrelated one.
2. **Configure the OAuth consent screen** (APIs & Services → OAuth consent
   screen). User type **External**, which is what allows any Google account to
   sign up, which is the open self-service decision above. Internal would
   restrict it to a Workspace org.
3. **Fill in the consent screen fields**: app name, user support email, developer
   contact email. Add `amazoncognito.com` and `simostack.com` under Authorized
   domains.
4. **Add scopes**: `openid`, `email`, `profile`. These are all non-sensitive, so
   Google does **not** require an app verification review. Adding a sensitive
   scope later would trigger one, which takes days.
5. **Publish the app.** This is the step that is easy to miss and the failure is
   confusing. While the consent screen is in **Testing**, only Google accounts
   explicitly added as test users can sign in, capped at 100. Everyone else
   gets `Error 403: access_denied` with no useful explanation. Open
   self-service sign-up requires status **In production**.
6. **Create credentials** (APIs & Services → Credentials → Create credentials →
   OAuth client ID). Application type **Web application**.
7. **Authorized JavaScript origins**: the hosted-UI origin, with no path.
   ```
   https://<CognitoDomainPrefix>.auth.ap-southeast-2.amazoncognito.com
   ```
8. **Authorized redirect URIs**: the same origin plus `/oauth2/idpresponse`.
   This must match exactly, with no trailing slash.
   ```
   https://<CognitoDomainPrefix>.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse
   ```
9. **Copy the client ID and client secret.** The ID is not sensitive; it appears
   in the sign-in redirect. The secret is a genuine secret. Unlike the
   bench-extract access token, this one is never published anywhere and should
   be treated accordingly.

## Deploying

Done: deployed 2026-08-25 as stack `bench-auth` in `ap-southeast-2`. Kept as
the record of how, and as the procedure for a rebuild. **Note
`DeletionProtection` is now `ACTIVE`** (since 2026-08-30), so tearing this pool
down means deploying it back to `INACTIVE` first.

```bash
cd bench-auth
sam deploy --guided \
  --parameter-overrides \
    GoogleClientSecret='<secret>'
```

There is **no `sam build` step**, unlike bench-extract. Every resource here is
plain CloudFormation with no code to package, so the template has no
`Transform:` line and there is nothing to build. `sam deploy` handles it fine.

Answer `Y` to **`Allow SAM CLI IAM role creation`**: the template declares
`AWS::IAM::Role` for the authenticated role. `CAPABILITY_IAM` is sufficient
because the role has no custom `RoleName`, the same reasoning as the
bench-extract README's note. Adding a `RoleName` later would start requiring
`CAPABILITY_NAMED_IAM`, with an error that does not explain why.

### Keep the client secret out of samconfig.toml

`samconfig.toml` is gitignored, but it is still a plaintext file on disk, and
guided mode offers to save every parameter into it. Say **no** to saving
parameters, or edit `GoogleClientSecret` back out of `parameter_overrides`
afterwards, and pass it on the command line on each deploy instead.

The retired bench-extract access token was held in SSM and resolved by
CloudFormation, so it was never typed at a prompt. That historical pattern
does not transfer directly: `AWS::SSM::Parameter::Value<String>` cannot read a
`SecureString`, and `{{resolve:ssm-secure}}` is restricted to an allowlist of
resource properties. Whether `AWS::Cognito::UserPoolIdentityProvider`'s
`ProviderDetails` is on that allowlist has **not been verified**. If it is,
moving the secret to a SecureString is a strict improvement and worth doing
before this goes to production.

### After deploy

- Confirm the stack's `GoogleRedirectUri` output matches what was registered in
  Google Cloud Console exactly.
- Run `bash bench-auth/verify-e2e.sh`. It does the sign-in, the Identity Pool
  exchange and the Bedrock deny check in one pass. See "Verifying" below.
- The `UserPoolClientId`, `IdentityPoolId` and `HostedUiDomain` outputs are what
  Phase 3 needs in `vue-simostack`. Nothing carries them across automatically,
  the same as the Function URL handoff.
- `DeletionProtection` on the User Pool is `ACTIVE` as of 2026-08-30, the
  Phase 3 entry gate (see "Phases" above). It was `INACTIVE` through Phases 1
  and 2, when the pool held only test accounts. A first deploy into a fresh
  account can start at `INACTIVE`, but note that with `ACTIVE` in the template
  as it now stands, tearing the stack down takes flipping it back and deploying
  that change first.

## Verifying

`verify-e2e.sh` is the check. Run it from the repo root:

```bash
bash bench-auth/verify-e2e.sh
```

It resolves every id from the stack's outputs, so there is nothing to edit and
no account id baked into it. It prints a hosted-UI URL, waits while you sign in
with Google, and takes the `?code=` from the address bar of the dead-port
redirect. Then it exchanges the code, gets Identity Pool credentials, and runs
the assertions.

Two things about it are load-bearing:

- **The probes run with `AWS_PROFILE` scrubbed.** Your admin credentials would
  otherwise satisfy a Bedrock call and the deny check would pass while proving
  nothing.
- **`invoke-model` passes `--cli-binary-format raw-in-base64-out`.** Without it
  the AWS CLI v2 rejects the JSON body locally, no request reaches Bedrock, and
  the check again passes vacuously. That bug shipped once already.

**Step 5 is phase-aware and needs no editing at cutover.** It reads the live
`AuthType` off the Function URL and asserts what that phase requires:

| `AuthType` | Phase | Unsigned call | Signed call |
| --- | --- | --- | --- |
| `NONE` | 1 | reaches the function | denied, the grant requires `AWS_IAM` |
| `AWS_IAM` | 2 | **403** | authenticates |

Under `NONE`, a denied signed call is correct, not a regression. The `AWS_IAM`
row is the pair of cutover gates from the Phases section, so re-run this
straight after the Phase 2 deploy.

Re-running always needs a browser: the client's `ExplicitAuthFlows` is
`ALLOW_REFRESH_TOKEN_AUTH` alone, with no password flow, so a federated user's
credentials cannot be obtained headlessly.

Note that under `AuthType: NONE` the unsigned probe is a real invocation and
costs a real Bedrock call.

## Verification limits and remaining housekeeping

- Authentication phases 1–4 are complete. The 2026-09-13 check verified AWS
  configuration and SSM deletion; it did not rerun the browser-based 12/12
  authentication suite. Product work is tracked in
  [BENCH-ROADMAP.md](../BENCH-ROADMAP.md).
- `bedrock:InvokeModel` is now proven denied by an observed live refusal, not
  only by `simulate-principal-policy`: the 2026-08-29 run passed step 4 with
  `--cli-binary-format raw-in-base64-out` in place, so the call reached Bedrock
  and was refused there. Same `Deny bedrock:*` statement as
  `ListFoundationModels`, now with the same class of evidence behind it.
- Whether the Google client secret can live in SSM as a `SecureString` is
  unverified. See above.
