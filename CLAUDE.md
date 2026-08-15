# simostack-infra

Backend AWS infra for simostack.com, deployed independently of the frontend
(vue-simostack) — separate CI, separate deploy lifecycle, separate repo by
design.

## Structure
- `bench-extract/` — Bedrock-backed Lambda (listing extraction), SAM app. Built
  and deployed.
- `bench-auth/` — Cognito auth for Bench. README only, nothing built (see below).
- `SECURITY.md` — repo-wide threat model and guardrail rationale.
- `README.md` — repo overview, deploy model, cross-repo handoff.
- `.github/workflows/` — one test workflow per service.

## Where the documentation lives

The READMEs are the source of truth and are detailed. Read rather than infer:

- `SECURITY.md` — why each guardrail exists, and the **design checklist for a
  new public Bedrock endpoint**. It applies to every service here, `bench-auth`
  included, not just bench-extract. Read before writing a public endpoint or
  loosening a guardrail.
- `bench-extract/README.md` — the procedure: account prerequisites, first
  deploy, token rotation, incident recovery.
- `bench-auth/README.md` — what the service is meant to replace.

## Conventions

- **Per-service, not workspace-hoisted.** Each service has its own
  `package.json`, lockfile, `node_modules` and vitest config. `sam build` copies
  a service directory expecting deps to resolve from inside it — don't hoist to
  root, and don't add a root workspace.
- **Deploy is manual**, from within each service dir: `sam build && sam deploy`,
  with `--guided` on first deploy. No CI deploys anything; CI only runs tests.
- **No root-level stack** tying services together, deliberately.
- **`samconfig.toml` and `.aws-sam/` are gitignored repo-wide**, matched at any
  depth (`**/samconfig.toml`), so a new service directory is covered the day it
  is created. `samconfig.toml` holds stack name, region, capabilities and
  `parameter_overrides` (budget caps, alert email, model IDs, and the SSM
  parameter *name*) — never the access token itself, which CloudFormation
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
  into `.aws-sam/build/`, so without the exclude vitest runs every test twice —
  the second time against a stale gitignored snapshot. Spread
  `configDefaults.exclude`; replacing it silently re-enables `node_modules`.

**Node versions differ on purpose:** local dev is on 22, while `template.yaml`
sets `nodejs24.x` and CI pins Node 24. CI is the only place the code runs on the
version that serves it in production.

## CI

`.github/workflows/bench-extract-tests.yml` — tests only, no deploy. It is
paths-filtered to `bench-extract/**` plus its own file, and sets
`working-directory: bench-extract` with `cache-dependency-path` pointed at the
service lockfile (the cache step resolves that from the repo root regardless of
`working-directory`).

**A new service gets a new workflow file**, not another branch inside this one —
a repo-wide test job would have to know every service directory or force a root
workspace. `bench-auth` will need `.github/workflows/bench-auth-tests.yml`.

## Deployed state (verified 2026-08-16)

- The bench-extract stack is deployed in **`ap-southeast-2` under the stack name
  `sam-app`** — the `--guided` default, never changed. There is no stack named
  `bench-extract`; looking for one and concluding nothing is deployed is the
  easy mistake. The Lambda itself is `bench-extract`.
- Reserved concurrency is 1, matching the template. `bench-extract-high-invocations`
  (logical ID `BenchHighInvocationAlarm`) is in `OK`.
- Budget parameters are still the placeholder defaults (`BudgetMonthlyLimitUsd=5`,
  `EarlyWarningBudgetUsd=1`) that `bench-extract/README.md` says to replace with
  real values.
- **The AWS CLI and SAM CLI are installed here and credentials are live and
  admin-level.** `sam validate --lint` passes against `template.yaml`, and
  read-only `aws` calls work. This means a deploy is *possible* from this
  environment — do not run one unless asked. Note especially the README's
  warning: never `sam deploy` your way out of a fired kill switch, since it
  silently resets concurrency and reopens the endpoint.
- The real Bedrock path has been exercised in production (invocations logged
  2026-08-08/09, 1.3-2.7s, no Bedrock errors). The alarm → SNS → kill-switch
  chain has **not** — the alarm has only ever gone `INSUFFICIENT_DATA` → `OK`.

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
error — the site calls the old one and every extraction fails as a network error
that reads like a Lambda fault.

## bench-auth (next up, not started)

Cognito User Pool + Google as federated IdP, self-service sign-up (no manual
approval). Use a Cognito **Identity Pool**, not a User Pool alone, so
authorization is enforced via IAM role + condition keys rather than application
code — that is the actual point of this piece, not just adding a login screen.

Before writing any of it, work through the design checklist in `SECURITY.md`.

What it replaces: the shared `x-bench-token` header, checked in
`bench-extract/index.mjs` (~line 153) against an SSM-sourced env var. That token
ships in the public JS bundle and was never a secret; what actually bounds abuse
is the Bedrock quota, reserved concurrency, the kill switch and the budget
action.

Two things to get right, both easy to get subtly wrong:

1. **The budget circuit breaker does not automatically cover a new role.** The
   Budgets-triggered deny (`BenchDenyBedrockPolicy`, `Resource: '*'` on
   `bedrock:InvokeModel`) is attached by `BenchBudgetAction` to exactly one role
   — the `Roles:` list names only `BenchExtractFunctionRole`. So:
   - If Bench users keep reaching Bedrock *only through the Lambda*, the
     existing deny still covers all spend, and the authenticated role needs
     nothing more than `lambda:InvokeFunctionUrl`. This is the simpler design.
   - If the authenticated role is ever granted direct Bedrock access, it must be
     added to that `Roles:` list, or the enforcement budget has a hole. The
     account-wide budget would still *notice* the spend; it just wouldn't stop it.
2. **Switching the Function URL off `AuthType: NONE`** to `AWS_IAM` touches more
   than one file: the `Cors` block still allowlists the `x-bench-token` header,
   the handler's token check has to go or become conditional, and the frontend
   call has to start signing SigV4. Landing this changes `bench-extract`,
   `bench-auth` and `vue-simostack` together.
