# SECURITY.md: public endpoints that call a metered AI API

Standing checklist for any Lambda in this repo that sits on a public URL and
calls Amazon Bedrock (today: `lambda/bench-extract/`). Read it before writing
a new one, and before `sam deploy` on an existing one. It explains _why_ each
guardrail is there, because a guardrail whose reasoning is lost gets deleted
by the next person who finds it inconvenient.

## The actual threat model

Be honest about what is being defended. This is a personal tool on a personal
AWS account. Nobody is targeting it. The realistic failure modes, in order of
likelihood:

1. **My own bug.** A retry loop, a double-fire in the frontend, a test script
   left running. By far the most likely way to spend real money.
2. **Opportunistic bots.** Public Lambda Function URLs get scanned and hit
   within hours of existing. They are not after the data; they will hammer
   anything that responds.
3. **Someone finding the shared token** in the JS bundle, where it is plainly
   visible, and deciding to use the endpoint as free infrastructure.

The blast radius of all three is **a bill**, not a breach: there is no
customer data behind this endpoint, no database, and no VPC. So the guardrails
optimise for _bounding spend fast_ and _failing closed_, not for perfect
authentication. Getting locked out of my own tool for ten minutes costs
nothing; a runaway loop billing overnight costs real money.

## Guardrail layers

Ordered by reaction time, fastest first. Each layer stops a different thing;
none of them is sufficient alone, which is the entire point of having several.

| Layer                              | Reacts in | Stops                                        | Does **not** stop                          |
| ---------------------------------- | --------- | -------------------------------------------- | ------------------------------------------ |
| Bedrock model access (account)     | instant   | Calls to any model not explicitly enabled    | Abuse of the models you did enable         |
| Service Quota (account)            | instant   | Sustained request rate above the quota       | A burst under the quota                    |
| URL allowlist (`assertAllowedUrl`) | instant   | Using the endpoint as a fetch proxy          | Spend from legitimate-looking listing URLs |
| Response size cap                  | instant   | Buffering a huge response body               | Responses that declare no `content-length` |
| `ReservedConcurrentExecutions`     | instant   | Parallelism, so _rate_ of spend              | Total spend over time                      |
| CloudWatch alarm → kill switch     | ~1-6 min  | Everything, by setting concurrency to 0      | Spend already incurred before it fired     |
| Budget + BudgetsAction             | 6-24 h    | Everything, by denying `bedrock:InvokeModel` | Anything fast; it is the backstop          |

### Open fetch proxy is the real code-level risk

A handler that accepts a URL from the internet and fetches it server-side is a
proxy. Without an allowlist, anyone holding the token can point it at any host
and read the response back through the extraction result, using my AWS
account's network and my Bedrock budget to do it.

**Rule: any user-supplied URL gets an exact-host allowlist and an https-only
check, enforced inside the function that performs the fetch** (not in the
caller, so a second call site cannot skip it). Match hosts exactly. A
`hostname.endsWith('domain.com.au')` check also accepts `evil-domain.com.au`.

Two things make this less severe here than the generic SSRF case, and both are
worth knowing so the risk is neither over- nor under-rated:

- **The function is deliberately not in a VPC.** Bench needs no private
  resources: no RDS, no internal services, nothing on a private subnet. There
  is therefore nothing for an SSRF to pivot into, and no drawback to staying
  outside a VPC. This is a design decision, not an oversight.
- **Lambda has no EC2-style instance metadata endpoint.** Credentials arrive
  as environment variables, so `169.254.169.254` is not a target.

So the residual risk is abuse-of-resources, not credential theft. The
allowlist closes it.

**Redirects are followed, deliberately.** `fetch` defaults to following them,
and an allowlisted host could in principle redirect somewhere else. That is
accepted rather than fixed, and it is the non-VPC decision above that makes it
acceptable: a redirect has nowhere interesting to go.

> ⚠️ **Re-review trigger.** The moment a Bench feature needs VPC access (a
> database being the obvious one), the "nothing to pivot into" reasoning stops
> holding and following redirects becomes a real SSRF path into the private
> subnet. Attaching the function to a VPC and leaving this alone is the
> failure mode to avoid. The fix at that point is `redirect: 'manual'` with
> `assertAllowedUrl` re-run on every hop. Treat adding a VPC config to
> `template.yaml` as the thing that requires revisiting this section.

### Response size caps

Two paths, because not every response declares its size:

- **`content-length` present:** reject before reading anything if it exceeds
  the ceiling (2MB here).
- **`content-length` absent** (chunked responses): read the body a chunk at a
  time, keep a running byte total, and abort mid-stream once it passes the
  same ceiling.

The streaming path is the one that actually bounds memory: an oversized body
is never fully buffered, whatever the server sends. Cancel the reader when you
bail so the socket is released rather than left to drain.

Watch the null handling. `headers.get('content-length')` returns `null` when
the header is absent, and `Number(null)` is `0`, which is finite. A check
written as `Number.isFinite(n) && n > MAX` therefore reads a missing header as
a declared size of zero and waves it straight through. Test the header's
presence explicitly before parsing it.

**Residual gap:** a server that declares a small `content-length` and then
sends more is still trusted on the fast path. Not worth closing for
allowlisted commercial sites; it would matter if the allowlist ever included a
host you did not trust to be well behaved.

### Reserved concurrency is a rate limit, not a spend cap

This is the distinction that matters most and is easiest to get wrong.

`ReservedConcurrentExecutions: N` caps how many invocations run _at once_. It
bounds the **derivative** of spend, not the total. At concurrency 1, a loop
still runs forever; it just runs one call at a time. Left alone overnight it
will happily spend hundreds of dollars.

Set it to the smallest number that does not degrade real use. For a
single-user tool that number is **1**: nobody adds two listings
simultaneously, and halving concurrency halves the worst-case burn rate for
literally no cost. Do not reach for a larger number for "headroom"; headroom
is exactly what a runaway loop consumes.

Setting it to **0** is different in kind: every invocation is throttled before
any code executes. That is why the kill switch uses it.

### Budgets lag; CloudWatch does not

**AWS Budgets runs on Cost Explorer data and can lag 6-24 hours.** A
`BudgetsAction` that attaches a deny policy at $5 will not necessarily fire
until long after $5 has been spent. It is a real cap on the _month_, and
useless against a loop that starts at 11pm.

So pair it with a CloudWatch alarm on the function's own `Invocations` metric,
which lands in about a minute, wired to an SNS topic and a subscriber Lambda
that calls `PutFunctionConcurrency` with `ReservedConcurrentExecutions: 0`.

Read the pair as: **the alarm is fast and dumb, the budget is slow and
accurate.**

- The alarm counts _requests_, not dollars. It will trip on a flood of cheap
  401 rejections that never reach Bedrock. That is fine and intended, because
  abnormal traffic is the leading indicator, and a false trip costs one manual
  command.
- The budget knows dollars exactly and will catch slow-drip abuse that never
  crosses a rate threshold. It just cannot catch it quickly.

**Alarm period is a real tradeoff.** A 5-minute period with a threshold of 100
means the alarm state change lands roughly 1-6 minutes after a burst starts,
depending where in the window it began. Shortening `Period` to 60 with a
proportionally lower threshold detects faster at the cost of more false trips.
Pick based on how much a false trip actually costs you; here it is one command,
so err fast.

### Fail closed, recover by hand

Neither circuit breaker self-heals, deliberately. If one fired, something was
wrong and a human should find out what before the endpoint is live again.

Recovery after the kill switch:

```bash
aws lambda put-function-concurrency \
  --function-name bench-extract \
  --reserved-concurrent-executions 1
```

Recovery after the budget action: Budgets → Actions → Revert, in the console.

**Watch for drift.** The kill switch changes reserved concurrency outside
CloudFormation, so the stack is now out of sync with reality. The next
`sam deploy` silently resets concurrency to the template value and turns the
endpoint back on. Do not deploy your way out of an incident.

### A separate low budget for early warning

A budget that both warns and enforces has to sit at the pain threshold, which
means the first thing you hear about creeping spend is the circuit breaker
tripping. Split them:

- **Low budget (~$1), email only, no action.** Includes a FORECASTED
  notification, which is the earliest possible signal. Its job is to make you
  look, while the number is still small enough to be interesting rather than
  alarming.
- **High budget ($5), with the deny action.** The actual cap.

## Account-level items that live outside any repo

These cannot be expressed in `template.yaml` and are invisible to code review.
They have to be done by hand, and verified by hand, per account and per region.

- **Bedrock model access: enable specific models only.** Model access is
  granted per model in the Bedrock console. Enable exactly the model the
  function uses (here, Claude Haiku) and nothing else. This is what makes the
  IAM policy's model-scoped `Resource` ARN meaningful rather than decorative:
  even if something widened that policy, an unapproved model still cannot be
  invoked. Blanket-enabling every model in the catalogue quietly removes a
  whole layer, and Opus-tier pricing is roughly an order of magnitude above
  Haiku's, so the cost of getting this wrong is not marginal.

- **Service Quotas: decreases need a support case, not a console click.** The
  Bedrock on-demand rate quotas are the only control enforced synchronously on
  every single `InvokeModel` call, with zero lag. They are also the most
  annoying to change: the Service Quotas console form is built for _increases_,
  and a decrease generally requires opening an AWS Support case. So do it
  early rather than during an incident, and set it to roughly 1-2x realistic
  personal usage. Being unable to lower a quota quickly is precisely why the
  faster in-repo guardrails above exist.

- **Confirm every email subscription.** Budgets and SNS each send a
  subscription-confirmation email after the first deploy. Until the link is
  clicked, the notification silently goes nowhere, and the alerting you think
  you have does not exist. Verify by checking the subscription shows
  `Confirmed`, not by assuming.

## Pre-deploy checklist

For a new public Lambda that calls Bedrock:

- [ ] Any user-supplied URL goes through an exact-host, https-only allowlist,
      enforced inside the fetching function
- [ ] Response size cap on anything fetched from outside, covering both the
      `content-length` and the chunked (streamed byte count) paths
- [ ] `ReservedConcurrentExecutions` set to the smallest workable number
- [ ] CloudWatch alarm on `Invocations` wired to a concurrency-zeroing Lambda
- [ ] Enforcement budget with a `BudgetsAction` deny policy
- [ ] Separate low email-only budget, including a FORECASTED notification
- [ ] IAM `Resource` scoped to the one model ARN, not `*`
- [ ] Bedrock model access enabled for that model **only**
- [ ] Bedrock service quota lowered (support case, do it early)
- [ ] All email subscriptions confirmed and showing `Confirmed`
- [ ] Shared secret is `NoEcho` and not committed in `samconfig.toml`

Before **every** deploy, not just the first:

- [ ] Check the CloudWatch alarm state (and your email) for a kill-switch trip
      first. A routine `sam deploy` silently resets reserved concurrency to the
      template value and reopens the endpoint, so deploying on top of a fired
      kill switch undoes it without telling you.

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
