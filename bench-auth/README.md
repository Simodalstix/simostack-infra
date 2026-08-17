# bench-auth

Cognito authentication for Bench: a User Pool with Google federation, an
Identity Pool, and an authenticated IAM role scoped to invoking the
bench-extract Function URL.

**Phase 1 is authored but nothing is deployed.** No AWS resources exist for this
stack. `template.yaml` has passed `cfn-lint` and `sam validate --lint`, which
confirms it is well-formed, not that it deploys cleanly.

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

`BenchDenyBedrockPolicy` is attached by `BenchBudgetAction` to exactly one role
— its `Roles:` list names only `BenchExtractFunctionRole`. Issuing Bedrock
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
- **Global caps only** — no per-user spend limits in the Lambda. Expected scale
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

1. **bench-auth standalone** — everything in this directory. Deploys and
   verifies without touching bench-extract. *Authored, not deployed.*
2. **bench-extract cutover** — `AuthType: AWS_IAM`, drop the token check,
   `Cors.AllowHeaders` loses `x-bench-token` and gains the SigV4 headers, read
   identity from `requestContext.authorizer.iam.cognitoIdentity`, concurrency to
   2. A Function URL cannot serve both auth modes at once, so there is a
   breakage window between this and Phase 3.
3. **vue-simostack** — login UI, SigV4 signing on the call, retire
   `VITE_BENCH_ACCESS_TOKEN`.
4. **Recalibrate and update `SECURITY.md`** — "the shared token is not
   authentication" closes as a gap; "open sign-up means anyone can spend the
   budget" opens in its place.

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
accounts, so choose something specific — `bench-simostack`, not `bench`. The
stack outputs `GoogleRedirectUri` so you can confirm the two agree after
deploying.

### Checklist

1. **Create or select a Google Cloud project** at
   <https://console.cloud.google.com/>. A dedicated project is easier to reason
   about later than reusing an unrelated one.
2. **Configure the OAuth consent screen** (APIs & Services → OAuth consent
   screen). User type **External** — this is what allows any Google account to
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
   explicitly added as test users can sign in, capped at 100 — everyone else
   gets `Error 403: access_denied` with no useful explanation. Open
   self-service sign-up requires status **In production**.
6. **Create credentials** (APIs & Services → Credentials → Create credentials →
   OAuth client ID). Application type **Web application**.
7. **Authorized JavaScript origins**: the hosted-UI origin, with no path.
   ```
   https://<CognitoDomainPrefix>.auth.ap-southeast-2.amazoncognito.com
   ```
8. **Authorized redirect URIs**: the same origin plus `/oauth2/idpresponse`.
   This must match exactly — no trailing slash.
   ```
   https://<CognitoDomainPrefix>.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse
   ```
9. **Copy the client ID and client secret.** The ID is not sensitive; it appears
   in the sign-in redirect. The secret is a genuine secret — unlike the
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
because the role has no custom `RoleName` — the same reasoning as the
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
`ProviderDetails` is on that allowlist has **not been verified** — if it is,
moving the secret to a SecureString is a strict improvement and worth doing
before this goes to production.

### After deploy

- Confirm the stack's `GoogleRedirectUri` output matches what was registered in
  Google Cloud Console exactly.
- Sign in once through the hosted UI to confirm a user is created in the pool
  and that the Identity Pool issues credentials.
- Confirm the credentials can invoke the bench-extract Function URL and **cannot**
  call Bedrock directly. The second half is the one worth actually testing — an
  `aws bedrock invoke-model` with those credentials should return `AccessDenied`.
- The `UserPoolClientId`, `IdentityPoolId` and `HostedUiDomain` outputs are what
  Phase 3 needs in `vue-simostack`. Nothing carries them across automatically,
  the same as the Function URL handoff.
- Flip `DeletionProtection` on the User Pool to `ACTIVE` once real users exist.
  Deleting a user pool deletes its users and they are not recoverable.

## Not yet done

- Nothing is deployed; no AWS resources exist for this stack.
- The Google Cloud Console prerequisites above have not been carried out.
- `cfn-lint` and `sam validate --lint` pass, which is static validation only.
  The stack has never been deployed, so nothing confirms the resources actually
  create — Cognito's cross-resource validation (IdP names, callback URL formats,
  domain-prefix uniqueness) mostly fails at deploy time, not lint time.
- Whether the Google client secret can live in SSM as a `SecureString` is
  unverified. See above.
