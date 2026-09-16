# simostack-infra

Backend AWS infra for simostack.com, deployed independently of the frontend
(vue-simostack): separate CI, separate deploy lifecycle, separate repo by
design.

## Structure
- `bench-extract/`: Bedrock-backed Lambda (listing extraction), SAM app. Built
  and deployed.
- `bench-auth/`: Cognito auth for Bench, replacing the shared `x-bench-token`
  header. All four phases are deployed and verified.
- `DEPLOYED.md`: live resource state, verification dates, the phase record and
  the kill-switch drill. Everything in this repo that carries a date lives
  there, so that this file can stay conventions only.
- `BENCH-ROADMAP.md`: completed authentication phases, current product gaps,
  and proposed milestones for account UI, scoring, URL import and persistence.
- `SECURITY.md`: repo-wide threat model and guardrail rationale.
- `README.md`: repo overview, deploy model, cross-repo handoff.
- `.github/workflows/`: one test workflow per service.

## Where the documentation lives

The READMEs are the source of truth and are detailed:

- `SECURITY.md`: why each guardrail exists, and the **design checklist for a
  new public Bedrock endpoint**. It applies to every service here, `bench-auth`
  included, not just bench-extract. Read before writing a public endpoint or
  loosening a guardrail.
- `bench-extract/README.md` is the procedure: account prerequisites, first
  deploy, incident recovery. There is no token rotation section any more; Phase
  4 cut it, and the reason it has no successor is written down in its place.
- `bench-auth/README.md`: what the service is meant to replace.

## Conventions

- **Per-service, not workspace-hoisted.** Each service has its own
  `package.json`, lockfile, `node_modules` and vitest config. `sam build` copies
  a service directory expecting deps to resolve from inside it, so don't hoist
  to root, and don't add a root workspace.
- **Deploy is per-service**, from within each service dir: `sam build && sam
  deploy`, with `--guided` on first deploy. Nothing here deploys automatically;
  CI only runs tests.
- **No root-level stack** tying services together, deliberately.
- **`samconfig.toml` and `.aws-sam/` are gitignored repo-wide**, matched at any
  depth (`**/samconfig.toml`), so a new service directory is covered the day it
  is created. `samconfig.toml` holds stack name, region, capabilities and
  `parameter_overrides` (budget caps, alert email, model IDs, and Cognito pool
  and client IDs). The shared-token SSM lookup was removed in Phase 4.
  Don't re-run `--guided` casually; its
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
`bench-auth/**`, but it lints instead of running unit tests. bench-auth has no
JavaScript, so there is no `package.json` and nothing for vitest to run. It
runs two linters: `cfn-lint` on `template.yaml` and `shellcheck` on
`verify-e2e.sh`. Steps here are **added, not swapped** -- if bench-auth ever
grows Lambda code (a pre-sign-up trigger, say), add a `npm test` step beside
these rather than replacing one.

`verify-e2e.sh` cannot run in CI: it needs live credentials and a human
completing a Google sign-in. `shellcheck` is the only automated check it gets,
and it catches quoting and unset-variable bugs, not the "check passes while
proving nothing" class that actually bit during Phase 1 verification.

## History

`bench-extract` was split out of `vue-simostack` with `git-filter-repo`, so
pre-split commits are the originals and their messages describe paths under
`lambda/bench-extract/`. Blame and log work; those paths don't resolve here.

## Known coupling (unenforced, documented only)

`bench-extract/index.mjs` is the request/response contract, and its consumer is
`src/components/bench/AddListingFlow.vue` in `vue-simostack`. Nothing tests that
they agree across the repo boundary, so a contract change here is half a change
until that file is updated.

Also carried by hand across that boundary: the Function URL, set as a GitHub
Actions secret on `vue-simostack` and in its local `.env`
(`VITE_BENCH_EXTRACT_URL`). A stale URL doesn't error: the site calls the old
one and every extraction fails as a network error that reads like a Lambda
fault. `VITE_BENCH_ACCESS_TOKEN` used to be carried the same way and is retired;
what crosses now instead are the bench-auth stack outputs the frontend signs
with (`UserPoolId`, `UserPoolClientId`, `IdentityPoolId`, `HostedUiDomain`).

## bench-auth (authentication phases 1–4 complete)

Replaced the shared `x-bench-token` header with Cognito. That token shipped in
the public JS bundle and was never a secret. **The header check is gone from
`bench-extract/index.mjs`**, removed at the Phase 2 cutover. Phase 4 then
removed the `BENCH_ACCESS_TOKEN` environment variable and the
`BenchAccessTokenParameterName` template parameter, and recalibrated
`SECURITY.md`.

See [DEPLOYED.md](./DEPLOYED.md) for what is live and when it was last
verified, and [BENCH-ROADMAP.md](./BENCH-ROADMAP.md) for unfinished features.
Scoring has no calculation implementation, URL fetching remains unreliable,
the nav identity is an indicator only, and listings are stored in localStorage.

Work through the design checklist in `SECURITY.md` before extending any of this.

### The load-bearing constraint

**The Lambda stays the only thing that calls Bedrock.** The authenticated
Identity Pool role gets `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`
on the one function ARN, restricted to the IAM-authenticated Function URL.
It must never get `bedrock:InvokeModel`.

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
  means quotas can be added later without a second cutover. The sub comes from
  a verified id_token in `x-bench-id-token`, not from the IAM request context,
  which cannot carry it over a Function URL (see Phase 2 below).
- **Fail closed on attribution.** A request that IAM allows but that carries no
  verifiable id_token gets a 401, before any fetch or Bedrock call. A null sub
  is indistinguishable from a caller who left the header off, so a log line
  that tolerates one cannot be trusted and a quota built on it could be opted
  out of by anyone already holding the role. This is attribution, not a second
  authorization layer, and it is not the `x-bench-token` shared secret
  returning: the id_token is a short-lived RS256 JWT scoped to one user.

**Consequence of open sign-up + global caps:** anyone with a Google account can
sign up and spend the Bedrock budget. That is accepted, but it makes
`BudgetMonthlyLimitUsd` the actual security boundary rather than a placeholder.

### Phases, deployed state and the kill-switch drill

Moved to [DEPLOYED.md](./DEPLOYED.md). All four authentication phases are
complete; that file records what each one changed, what was verified and when.
