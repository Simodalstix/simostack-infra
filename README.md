# simostack-infra

Backend and AWS-service infrastructure-as-code for simostack.com. One
directory per service, each independently deployable.

The frontend lives in a separate repo, `vue-simostack`, which builds and
deploys the static site to S3/CloudFront via GitHub Actions. Nothing in this
repo is deployed by that pipeline, and nothing here is deployed by CI at all.

## Services

| Directory       | What it is                                        | State           |
| --------------- | ------------------------------------------------- | --------------- |
| `bench-extract` | Lambda + Function URL. Listing extraction via Bedrock. | Deployed, live |
| `bench-auth`    | Cognito setup for Bench auth.                     | Placeholder, not built |

## How deploys work

By hand, per service, from that service's directory:

```bash
cd bench-extract
sam build && sam deploy
```

Tests run the same way, per service, from that service's directory:

```bash
cd bench-extract
npm install && npm test
```

Each service owns its own `package.json`, lockfile and vitest config. There is
no npm workspace at the root on purpose: workspaces hoist `node_modules`
upward, and `sam build` copies a service directory expecting its dependencies
to resolve from inside it.

There is deliberately no root-level stack tying the services together, and no
CI deploy. These are low-traffic services deployed a handful of times a year;
a pipeline would be more machinery than the problem justifies. The tradeoff is
that deploying is a thing you remember to do, and each service's README is the
procedure of record.

## The cross-repo handoff

`bench-extract` produces a Function URL that the frontend needs at build time.
Nothing carries it across automatically. After a deploy that replaces (rather
than updates) the Lambda, the URL changes, and a stale value in `vue-simostack`
does not error: the site keeps calling the old URL and every extraction fails
as a network error that looks like a Lambda fault.

`bench-extract/README.md` has the full procedure. The short version is that the
URL and access token get set by hand as GitHub Actions secrets on
`vue-simostack`, and `scripts/post-deploy.sh` in that repo checks the local
`.env` against the deployed stack.

## History

`bench-extract` was extracted from `vue-simostack` with `git-filter-repo`, so
commits before the split are the original ones and still describe paths under
`lambda/bench-extract/`. Blame and log work; paths in old commit messages do
not resolve against this tree.
