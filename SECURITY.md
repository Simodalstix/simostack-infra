# SECURITY.md: public endpoints that call a metered AI API

Why each guardrail on the Bench extraction Lambda exists and what it does not
cover, kept separate from the procedure because a guardrail whose reasoning is
lost gets deleted by whoever next finds it inconvenient.

The Lambda itself now lives in the separate `simostack-infra` repo, under
`bench-extract/`. This file stayed here, which is worth knowing about: the
code and the reasoning behind its guardrails are one repo apart, so a change
to `template.yaml` over there does not surface this file to whoever is making
it.

Read this before writing a new public endpoint or changing an existing one's
guardrails. **Deploy steps, account setup and the incident runbook are in
`bench-extract/README.md` in `simostack-infra`**, which is the one to open
when you are about to deploy.

## The threat model

This is a personal tool on a personal AWS account. Nobody is targeting it. The
realistic failure modes, in order of likelihood:

1. **My own bug.** A retry loop, a double-fire in the frontend, a test script
   left running. By far the most likely way to spend real money.
2. **Opportunistic bots.** Public Lambda Function URLs get scanned within hours
   of existing. They are not after data; they hammer anything that responds.
3. **Someone finding the shared token** in the JS bundle, where it is plainly
   visible, and using the endpoint as free infrastructure.

The blast radius of all three is **a bill, not a breach**: no customer data
behind the endpoint, no database, no VPC. So the guardrails optimise for
bounding spend fast and failing closed, not for perfect authentication. Being
locked out of my own tool for ten minutes costs nothing. A runaway loop billing
overnight costs real money.

## Guardrail layers

Ordered by reaction time, fastest first. Each layer stops a different thing;
none is sufficient alone, which is the entire point of having several.

| Layer                              | Reacts in | Stops                                        | Does **not** stop                          |
| ---------------------------------- | --------- | -------------------------------------------- | ------------------------------------------ |
| Bedrock model access (account)     | instant   | Calls to any model not explicitly enabled    | Abuse of the models you did enable         |
| Service Quota (account)            | instant   | Sustained request rate above the quota       | A burst under the quota                    |
| URL allowlist (`assertAllowedUrl`) | instant   | Using the endpoint as a fetch proxy          | Spend from legitimate-looking listing URLs |
| Response size cap                  | instant   | Buffering a huge response body               | Responses that declare no `content-length` |
| `ReservedConcurrentExecutions`     | instant   | Parallelism, so _rate_ of spend              | Total spend over time                      |
| CloudWatch alarm → kill switch     | ~1-6 min  | Everything, by setting concurrency to 0      | Spend already incurred before it fired     |
| Budget + BudgetsAction             | 6-24 h    | Everything, by denying `bedrock:InvokeModel` | Anything fast; it is the backstop          |

## Why each layer is shaped the way it is

### An open fetch proxy is the real code-level risk

A handler that accepts a URL from the internet and fetches it server-side is a
proxy. Without an allowlist, anyone holding the token can point it at any host
and read the response back through the extraction result, using this account's
network and Bedrock budget to do it.

**Rule: any user-supplied URL gets an exact-host, https-only check enforced
inside the function that performs the fetch**, not in the caller, so a second
call site cannot skip it. Match hosts exactly. A
`hostname.endsWith('domain.com.au')` check also accepts `evil-domain.com.au`.

Two things make this less severe than the generic SSRF case, so the risk is
neither over- nor under-rated. **The function is deliberately not in a VPC**:
Bench needs no private resources, so there is nothing to pivot into and no
drawback to staying outside. And **Lambda has no EC2-style metadata endpoint**,
since credentials arrive as environment variables, so `169.254.169.254` is not
a target.

Residual risk is therefore abuse-of-resources, not credential theft, and the
allowlist closes it. **Redirects are followed deliberately**: an allowlisted
host could in principle redirect elsewhere, but per the above it has nowhere
interesting to go.

> ⚠️ **Re-review trigger.** The moment a Bench feature needs VPC access (a
> database being the obvious one), the "nothing to pivot into" reasoning stops
> holding and following redirects becomes a real SSRF path into the private
> subnet. Attaching the function to a VPC and leaving this alone is the failure
> mode to avoid. The fix at that point is `redirect: 'manual'` with
> `assertAllowedUrl` re-run on every hop. Treat adding a VPC config to
> `template.yaml` as the thing that requires revisiting this section.

### Response size caps need two paths

Not every response declares its size. With `content-length` present, reject
before reading anything if it exceeds the ceiling (2MB here). With it absent
(chunked), read the body a chunk at a time against a running byte total and
abort mid-stream at the same ceiling. The streaming path is the one that
actually bounds memory, and cancelling the reader on bail releases the socket
rather than leaving it to drain.

**Watch the null handling.** `headers.get('content-length')` returns `null`
when absent, and `Number(null)` is `0`, which is finite. A check written as
`Number.isFinite(n) && n > MAX` therefore reads a missing header as a declared
size of zero and waves it through. Test the header's presence before parsing.

**Residual gap:** a server that declares a small `content-length` then sends
more is still trusted on the fast path. Not worth closing for allowlisted
commercial sites; it would matter if the allowlist ever included a host you did
not trust to behave.

### Reserved concurrency is a rate limit, not a spend cap

The distinction that matters most and is easiest to get wrong.
`ReservedConcurrentExecutions: N` caps how many invocations run _at once_. It
bounds the **derivative** of spend, not the total. At concurrency 1 a loop
still runs forever, one call at a time, and left overnight will happily spend
hundreds of dollars.

Set it to the smallest number that does not degrade real use. For a single-user
tool that is **1**: nobody adds two listings simultaneously, and halving
concurrency halves the worst-case burn rate at no cost. Do not reach for a
larger number as headroom; headroom is exactly what a runaway loop consumes.

Setting it to **0** is different in kind, throttling every invocation before any
code executes. That is why the kill switch uses it.

### Budgets lag; CloudWatch does not

**AWS Budgets runs on Cost Explorer data and can lag 6-24 hours.** A
`BudgetsAction` that denies at $5 may not fire until long after $5 is spent. It
is a real cap on the _month_ and useless against a loop that starts at 11pm.

So pair it with a CloudWatch alarm on the function's own `Invocations` metric,
landing in about a minute, wired through SNS to a Lambda that calls
`PutFunctionConcurrency` with `0`. Read the pair as **the alarm is fast and
dumb, the budget is slow and accurate**:

- The alarm counts _requests_, not dollars, so it trips on a flood of cheap 401
  rejections that never reach Bedrock. Intended: abnormal traffic is the
  leading indicator and a false trip costs one manual command.
- The budget knows dollars exactly and catches slow-drip abuse that never
  crosses a rate threshold. It just cannot catch it quickly.

**Alarm period is a real tradeoff.** A 5-minute period at threshold 100 lands
roughly 1-6 minutes after a burst starts, depending where in the window it
began. A 60-second period with a proportionally lower threshold detects faster
at the cost of more false trips. Price it by what a false trip costs; here that
is one command, so err fast.

### Two budgets, not one

A budget that both warns and enforces has to sit at the pain threshold, which
means the first news of creeping spend is the circuit breaker tripping. Split
them: a **low budget (~$1), email only, no action**, including a FORECASTED
notification for the earliest possible signal, and a **high budget ($5) with
the deny action** as the actual cap. The low one exists to make you look while
the number is still interesting rather than alarming.

### Fail closed, recover by hand

Neither circuit breaker self-heals, deliberately. If one fired, something was
wrong and a human should find out what before the endpoint is live again.

The recovery commands are in the Lambda README (`bench-extract/README.md` in
`simostack-infra`, "Incident recovery"), along with
the drift warning that matters most: the kill switch changes concurrency
outside CloudFormation, so a routine `sam deploy` silently reopens the
endpoint.

## Design checklist for a new public Bedrock endpoint

Build-time properties, all expressible in code or `template.yaml`. The
deploy-time and account-level steps are in the Lambda README.

- [ ] Any user-supplied URL goes through an exact-host, https-only allowlist,
      enforced inside the fetching function
- [ ] Response size cap covering both the `content-length` and chunked paths
- [ ] `ReservedConcurrentExecutions` set to the smallest workable number
- [ ] CloudWatch alarm on `Invocations` wired to a concurrency-zeroing Lambda
- [ ] Enforcement budget with a `BudgetsAction` deny policy
- [ ] Separate low email-only budget, including a FORECASTED notification
- [ ] IAM `Resource` scoped to the one model ARN, not `*`
- [ ] Shared secret is `NoEcho` and not committed in `samconfig.toml`

## What none of this covers

Stated plainly so it is not mistaken for done:

- **The shared token is not authentication.** It ships in the public JS bundle.
  It filters bots; it does not stop a person who reads the bundle.
- **No per-caller rate limiting.** Concurrency is global, not per-IP. A single
  abusive caller and normal use are indistinguishable to it.
- **No log retention or failure alerting configured.** You will find out about
  extraction failures from the UI, not from CloudWatch.
- **The budget is account-wide for the Bedrock service**, not scoped to this
  function. Another Bedrock workload in the same account would share the cap.
