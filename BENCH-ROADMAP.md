# Bench roadmap

Updated 2026-09-13. This is the product status and next-work record across
`simostack-infra` and the sibling `vue-simostack` repo. Authentication deployment
procedures remain in [bench-auth/README.md](./bench-auth/README.md); extraction
deployment and recovery remain in [bench-extract/README.md](./bench-extract/README.md).

## Completed authentication phases

| Phase | Outcome | Completion evidence |
| --- | --- | --- |
| 1 — Identity | Cognito User Pool, Google federation, Identity Pool, restricted caller role | `bench-auth` deployed 2026-08-25; browser-based verification 2026-08-27 |
| 2 — Protect extraction | IAM-authenticated Function URL, verified Cognito id_token, caller attribution | Deployed 2026-08-29; `verify-e2e.sh` passed 12/12 |
| 3 — Frontend login | Google login, SigV4 signing, signed-in nav indicator; requests no longer send the shared token | Frontend implementation and prior live verification recorded before Phase 4; User Pool deletion protection deployed 2026-08-30 |
| 4 — Retire shared token | Remove template parameter, Lambda environment variable and obsolete SSM parameter; update threat model | Authored 2026-09-01; deployed and checked 2026-09-13 |

On 2026-09-13, `sam-app` reported `UPDATE_COMPLETE`; the Lambda environment
and stack parameter list no longer contained the shared token; the Function
URL still used `AWS_IAM` and its address was unchanged. After the user deleted
`/bench/access-token`, an SSM metadata lookup returned no matching parameter.
These were configuration checks, not a fresh run of the browser sign-in suite.

Removal of any unused `VITE_BENCH_ACCESS_TOKEN` entry from frontend local env
files and GitHub Actions secrets was previously recorded as in flight. Its
completion has not been checked here. The frontend request code no longer
uses it, so this is housekeeping, not an authentication dependency.

## What the product actually does today

The 2026-09-13 code review found the following. Frontend paths below are
relative to `vue-simostack`; that checkout also contains unrelated uncommitted
work and one local commit ahead of `origin/main`. Code findings describe the
checkout; they are not a claim that every frontend change is deployed.

| Feature | Current behavior | Evidence |
| --- | --- | --- |
| Account indicator | Initial with an email tooltip; no expandable menu | `src/components/bench/BenchNavIdentity.vue` |
| Session display | Email and sign-out are already available to components | `src/composables/useBenchAuth.js` |
| Listing extraction | Text extraction is implemented; URL retrieval uses a plain server fetch | `bench-extract/index.mjs` in this repo |
| Value score | New listings get `null`; only the two sample listings have hardcoded scores (91 and 76) | `src/data/bench/listingSchema.js` |
| Score presentation | Displays and sorts `valueScore`; `valueBands.js` supplies colors/labels, not a calculation | `src/components/bench/ListingGrid.vue`, `ListingRow.vue`, `src/data/bench/valueBands.js` |
| Route estimates | New listings have no commute/childcare estimate; one heading hardcodes a work address | `src/data/bench/listingSchema.js`, `src/components/bench/ListingRow.vue` |
| Saved listings | One browser-local `bench.listings.v1` key, with no account namespace or server storage | `src/data/bench/benchStorage.js` |

The scoring problem is missing implementation, not something another SAM
deploy will enable. The current extraction contract returns listing facts;
it does not calculate a score. The page's promise that listings are ranked by
value is ahead of the functionality.

## Proposed next milestones

These continue after the completed auth phases. They are proposed work,
not implemented features or agreed scoring formulas. Start the URL-access
trial early while the small account UI and scoring definition progress.

### 5 — Expandable account menu

Turn the nav indicator into a button that opens account details and sign-out.
Show the email already available from the session, and a display name only
when available. Keep tokens and internal identifiers out of the menu. Include
keyboard activation, Escape/outside-click dismissal, focus return and mobile
layout verification.

**No database dependency.** Cognito already supplies the identity and the
session composable already supplies sign-out. Editable buyer preferences,
work/childcare destinations and synchronised settings are separate work.

Done when a signed-in user can open the menu from the nav, see their account,
and sign out; signed-out and session-restoring states remain coherent.

### 6 — Implement explainable listing scoring

First settle what the score measures: personal suitability, market value, or
both as separate outputs. Proposed first version: buyer suitability against
explicit preferences. A market-value claim needs comparable-property evidence
that Bench does not currently have; an asking price alone cannot establish it.

Define inputs and rules before choosing weights. Candidate inputs include
budget, bedrooms, parking and known ongoing costs; commute needs a real route
estimate or an explicit user-entered estimate. Distinguish hard requirements
from preferences and retain price qualifiers such as ranges/offers-over.

Implement a deterministic scoring function that returns the score, component
breakdown, rule version and missing inputs. Missing data must remain unknown,
not silently become zero cost or a favorable score. Decide and document the
minimum evidence needed to issue an overall score. The current OC-fee display
also turns a missing fee into `$0`; fix that alongside the scoring UI.

Done when adding/editing a real listing computes and updates its score,
changing preferences recomputes results, and each score can be explained.
Tests should cover tradeoffs, missing evidence, price floors and exclusions.
Demo scores must remain distinguishable from calculated ones. Keep Bench's
rules separate from Turf's protected suburb-scoring formulas.

**No database dependency for a first version.** Calculation can run in the
browser with local preferences. Account storage later persists its inputs.

### 7 — Restore URL import as the intended input

Target: paste a supported listing URL, retrieve its facts, review them, save.
Pasted text remains an explicit fallback. It does not satisfy the URL-import
milestone on its own.

The recorded 2026-08-08 checks found Domain returning 403 and REA returning
429 to the current fetch approach, including tests outside AWS. These sites
were not retested during the 2026-09-13 documentation update. The existing
handler also maps retrieval failures broadly to `URL_FETCH_BLOCKED`, so that
error alone is not proof every failure is bot protection.

Official documentation checked 2026-09-13 supports these investigation paths:

- **Domain API:** the Agents & Listings package documents
  [`GET /v1/listings/{id}`](https://developer.domain.com.au/docs/latest/apis/pkg_agents_listings/references/listings_get/),
  requiring `api_listings_read` or `api_listings_write`. Trial URL-to-ID lookup
  and mapping its structured fields into Bench's review form. Production
  entitlement, coverage and cost for this account remain unconfirmed.
- **REA access:** the
  [Listing Export API](https://developer-portal-prod-us-east-1.partner-platform.realestate.com.au/listing-export/overview/)
  is for partners authorised to export customer listings. It does not establish
  access to arbitrary consumer listing URLs for Bench. Verify a suitable
  provider/access arrangement before building against it.
- **Browser-assisted import candidate:** a user-clicked “Add to Bench” extension
  could read the listing page already open in their browser and transfer the
  relevant facts into Bench's authenticated review flow. Chrome's
  [`activeTab` permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
  provides temporary page access after a user action. This is an engineering
  proposal, not a tested importer or a claim of publisher permission. It avoids
  manual copy/paste but still requires opening the listing, so it is a different
  experience from URL-only import and needs a product decision.

Begin with a small trial using real listings from each desired source. Record
fields returned, missing fields, failure modes, latency and expected cost.
Assess any licensed retrieval provider against the same trial. Running a
browser on the server is not evidence by itself that the sites will allow it;
require a working repeatable trial before adopting that approach.

Done when the selected URL-only path works repeatedly on representative
listings from every source advertised as supported, preserves price
qualifiers/provenance, and distinguishes removed listings, temporary service
failures and blocked access. Keep API credentials server-side, retain request
bounds, and account for new provider costs: the existing Bedrock budget does
not cap a separate provider's bill.

### 8 — Account-backed listings and preferences

Add an authenticated persistence API and database so listings, notes,
preferences and destinations follow the signed-in account across devices.
Choose the store as part of that design; Cognito login alone is not storage.

The server must derive ownership from verified identity and enforce it on
every read/write. The existing shared localStorage key is not account
isolation. Define an explicit import for existing browser-local listings;
do not silently assign a shared browser's data to the next person to log in.
Handle sign-out/account switching and local caches deliberately.

Done when one account can save on one device and load/edit on another,
another account cannot read or change those records, existing local data can
be imported without loss/duplicates, and failures are visible. Update the
threat model, which currently assumes no database or stored customer data.

## Recommended immediate work

Build milestone 5, agree the meaning of the score and implement milestone 6,
and run the milestone 7 access trial early. Persistence is a separate
milestone; it should not delay the menu or the first useful calculation.
There is no outstanding authentication SAM deploy after Phase 4.
