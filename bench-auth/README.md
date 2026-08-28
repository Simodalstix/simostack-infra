# bench-auth

Cognito authentication for Bench: a User Pool with Google federation, an
Identity Pool, and an authenticated IAM role scoped to invoking the
bench-extract Function URL.

**Phase 1 is deployed** (2026-08-25) **and verified end-to-end** (2026-08-27),
as the stack `bench-auth` in `ap-southeast-2`. Phases 2, 3 and 4 have not
started. See "Verifying" below for what the verification does and does not
cover.

## What this replaces

Bench currently authenticates with a single shared access token
(`VITE_BENCH_ACCESS_TOKEN`), which is inlined into the public JS bundle and is
therefore readable by anyone who loads the site. It is not a secret and was
never treated as one. See the "Access token" section of
[`../bench-extract/README.md`](../bench-extract/README.md): what actually
bounds abuse today is the Bedrock quota, reserved concurrency, the kill switch
and the budget action, not the token. Those guardrails and the threat model
behind them are in [`../SECURITY.md`](../SECURITY.md), which this service is
expected to satisfy rather than replace.

## The constraint this service exists to hold

**The Lambda stays the only thing that calls Bedrock.** The authenticated
Identity Pool role gets `lambda:InvokeFunctionUrl` on the one function ARN and
nothing else. It never gets `bedrock:InvokeModel`.

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
   `Cors.AllowHeaders` loses `x-bench-token` and gains the SigV4 headers, read
   identity from `requestContext.authorizer.iam.cognitoIdentity`, concurrency to
   2. A Function URL cannot serve both auth modes at once, so there is a
   breakage window between this and Phase 3.
   - [ ] **Confirm the cutover actually closed the URL**, both halves: the
     changeset before executing it, and an unsigned `curl` after. See
     "Phase 2 checklist" below, which is the full step-by-step.
3. **vue-simostack**: login UI, SigV4 signing on the call, retire
   `VITE_BENCH_ACCESS_TOKEN`.
   - [ ] **Entry gate:** flip `DeletionProtection` on the User Pool from
     `INACTIVE` to `ACTIVE` and deploy that change *before* the login UI ships.
     `INACTIVE` is the right setting through Phases 1 and 2, while the pool
     holds only test accounts and may need tearing down; shipping the login UI
     is the moment it starts holding real users, and deleting a user pool
     deletes its users unrecoverably.
4. **Recalibrate and update `SECURITY.md`**: "the shared token is not
   authentication" closes as a gap; "open sign-up means anyone can spend the
   budget" opens in its place.

## Phase 2 checklist

Phase 2 edits `../bench-extract/`, not this directory, but it is bench-auth work
and the checklist lives here. Steps are lettered so they can be referred to:
A is read-only and can be run at any time, B is the change, C is what proves it.

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

Then, before executing anything:

- [ ] `sam build && sam deploy --no-execute-changeset`, and **read the
      changeset**. Both `AWS::Lambda::Permission` resources from step A must
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

From here until Phase 3 ships, the deployed frontend is broken: it still sends
`x-bench-token` and now gets a 403 on every extraction. That is the accepted
breakage window, not a regression.

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
      change that recalibrates `SECURITY.md`.

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

Not yet done. When it is:

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

This is a weaker story than the bench-extract access token, which is held in SSM
and resolved by CloudFormation so it is never typed at a prompt. That pattern
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
- Leave `DeletionProtection` on the User Pool at `INACTIVE`. That is correct for
  Phases 1 and 2, when the pool holds only test accounts; flipping it to
  `ACTIVE` is an entry gate on Phase 3 (see "Phases" above), not a step to do
  here.

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

## Not yet done

- Phase 1 is deployed and verified end-to-end. Phases 2, 3 and 4 have not
  started.
- `bedrock:InvokeModel` has been proven denied by `simulate-principal-policy`,
  not by an observed live refusal; `bedrock:ListFoundationModels` was denied
  live under real credentials, and both are the same `Deny bedrock:*` statement.
  A clean run of `verify-e2e.sh` closes this, since the base64 bug that caused
  it is fixed.
- Whether the Google client secret can live in SSM as a `SecureString` is
  unverified. See above.
