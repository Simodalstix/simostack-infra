# bench-auth

Placeholder. Cognito IaC for Bench authentication goes here. Nothing is built
or deployed yet.

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

Cognito is the intended replacement for that token, so this service and
`bench-extract` are coupled: the Lambda's authorisation check and the frontend
call in `vue-simostack` both change when this lands.

## Layout when it exists

Same shape as `bench-extract`: a `template.yaml` deployed by `sam deploy`, and
a README carrying the procedure. Per-service deploys, no shared root stack.
