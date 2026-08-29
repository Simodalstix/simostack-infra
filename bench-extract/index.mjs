// bench-extract/index.mjs
//
// Bench's listing-extraction Lambda. Request/response shapes and the
// extraction prompt are a fixed contract with the frontend's add-listing
// flow (src/components/bench/AddListingFlow.vue). Do not change field names
// on either side without updating both.
//
// Calls Claude via Amazon Bedrock, not the direct Anthropic API: auth is IAM
// (the function's execution role, granted bedrock:InvokeModel in
// template.yaml), so there is no static API key to store, leak, or rotate at
// all. The one declared dependency (@aws-sdk/client-bedrock-runtime) is the
// official AWS SDK, a materially different supply-chain risk than a random
// npm package.
//
// The Function URL is IAM-authenticated (AuthType: AWS_IAM, see
// template.yaml): Lambda refuses an unsigned or unauthorized request with 403
// before this handler runs, so there is no in-handler *authorization* check
// and no shared secret. The only principal granted lambda:InvokeFunctionUrl
// is the bench-auth authenticated Identity Pool role, so every event arriving
// here belongs to a signed-in Cognito user.
//
// WHICH signed-in user is a separate question, and IAM cannot answer it over
// a Function URL. requestContext.authorizer.iam.cognitoIdentity is documented
// as never populated there ("Function URLs don't use this parameter"), and
// Cognito's enhanced flow gives every user of the role the same assumed-role
// session name, so userArn and userId are identical across users too. The
// caller therefore sends its Cognito id_token in the x-bench-id-token header
// and verifyCallerToken below verifies it against the pool's JWKS.
//
// That is attribution, not a second authorization layer, and it is not the
// x-bench-token shared secret coming back: this is a short-lived RS256 JWT
// scoped to one user, signed by Cognito and verifiable here, and IAM still
// gates the endpoint underneath it.
//
// Any URL the caller asks for must still pass assertAllowedUrl: a signed-in
// user is authenticated, not trusted with an open fetch proxy. See
// ../../SECURITY.md for why each guardrail exists and what it does not cover.

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { CognitoJwtVerifier } from 'aws-jwt-verify'

// An inference profile ID (`au.anthropic.…`), not a bare foundation-model ID.
// Converse takes either in modelId; the profile keeps routing inside Australia
// and is what the execution role is scoped to. Don't strip the `au.` prefix
// here without widening the IAM policy in template.yaml to match.
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID
// BENCH_ACCESS_TOKEN is still set by template.yaml but deliberately not read
// here any more: IAM auth on the Function URL replaced the shared secret. The
// environment variable stays wired until Phase 4 so a rollback to the
// pre-cutover template is a single deploy.

// The Cognito pool an incoming id_token must come from. These arrive as plain
// template parameters (template.yaml), deliberately not as a CloudFormation
// ImportValue from the bench-auth stack: the two stacks are kept uncoupled,
// and an Export would make bench-auth undeletable and its outputs unrenamable
// from here. The cost is that these two values can drift if the pool is ever
// recreated, in which case every call 401s at once; bench-auth/verify-e2e.sh
// asserts they still match the live bench-auth stack outputs.
const USER_POOL_ID = process.env.USER_POOL_ID
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID
const ID_TOKEN_HEADER = 'x-bench-id-token'

const MAX_PAGE_TEXT_CHARS = 15000
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 8000
const BEDROCK_TIMEOUT_MS = 10000

// Without this allowlist the handler is an open fetch proxy: it takes a URL
// from an unauthenticated caller, fetches it server-side on AWS's network,
// and hands the body back. Restricting it to the two sites Bench actually
// supports means the endpoint can't be used to fetch arbitrary third-party
// content on someone else's behalf. https only, because an http URL would
// also make the fetch trivially interceptable.
//
// NEITHER SITE IS CURRENTLY FETCHABLE, and no header tweak changes that.
// Both sit behind bot protection that fingerprints the TLS handshake and
// HTTP/2 framing rather than reading the User-Agent, so a server-side client
// is rejected at the CDN edge before the request reaches an origin: Domain
// answers 403 from Akamai Bot Manager, realestate.com.au answers 429 from
// what looks like Kasada. Verified 2026-08-08 from a residential IP as well
// as from Lambda, with browser User-Agent and full browser header set, so it
// is neither the UA nor the AWS-origin address. An earlier note here called
// Domain "the verified-working pair"; that was wrong and is corrected.
//
// The allowlist stays because the URL path still exists and still needs
// bounding, but rawText is the working input and the UI now leads with it.
// Getting URL entry working again means Domain's official developer API,
// not a better scraper. Don't widen this list without a reason.
//
// REDIRECTS ARE FOLLOWED, deliberately. fetch's default is to follow, and
// an allowlisted host could in principle redirect somewhere else. That is
// acceptable only because this function is INTENTIONALLY kept outside a
// VPC: Bench needs no private resources (no RDS, no internal services), so
// there is nothing on a private network for a redirect to reach, and Lambda
// exposes no EC2-style metadata endpoint. There is no drawback to staying
// outside a VPC and it is what makes following redirects safe.
//
// If a future Bench feature ever needs VPC access, that reasoning collapses
// and this must be re-reviewed at that point: the fix is redirect: 'manual'
// with assertAllowedUrl re-run on every hop. See ../../SECURITY.md.
const ALLOWED_LISTING_HOSTS = [
  'domain.com.au',
  'www.domain.com.au',
  'realestate.com.au',
  'www.realestate.com.au',
]

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION })

const EXTRACTION_PROMPT = `You extract structured facts from an Australian real-estate listing page.
Input is raw page text (may include navigation cruft, ads, agent bios; ignore
anything not describing the property itself).

Return ONLY a JSON object with exactly these keys, no prose, no markdown fences:
{
  "address": string | null,       // street address only: unit/street number and
                                   // street name. No suburb, state, postcode,
                                   // agency name or development name.
  "suburb": string | null,        // suburb name alone, no state or postcode
  "price": number | null,         // AUD, numeric only (e.g. 565000). No currency
                                   // symbol, no separators, no "k"/"m" suffix.
                                   // See the price rules below: some listings
                                   // state no price at all, and null is correct
                                   // for those.
  "priceQualifier":               // what the price number actually represents.
    "exact" | "range" | "offers-over" | "auction" | "undisclosed" | null,
  "beds": number | null,          // whole number of bedrooms
  "baths": number | null,         // bathrooms; 1.5 is acceptable for a half bath
  "carSpace": string | null,      // short free text, e.g. "2 (stacker)", "1 (titled)"
  "ocFeePerWeek": number | null,  // owners corp / strata fee per week, AUD, rounded
                                   // to a whole dollar. See the conversion table
                                   // below and use it literally.
  "buildYear": number | null,     // four-digit year the building was completed.
                                   // For "circa 1970s" use 1970. Do not guess
                                   // from architectural style.
  "confidence": "high" | "low",   // "low" if the page looks incomplete, blocked,
                                   // or you had to infer rather than read a field directly
  "warnings": string[]            // see the mandatory warnings list below
}

Price rules. The number and the qualifier travel together, and the qualifier is
what stops a floor being compared against a real asking price:

  "$620,000"                  -> price 620000, qualifier "exact"
  "$620,000 - $660,000"       -> price 620000, qualifier "range"
  "Offers over $620,000"      -> price 620000, qualifier "offers-over"
  "Auction Saturday 1pm"      -> price null,   qualifier "auction"
  "Contact agent" / "POA"     -> price null,   qualifier "undisclosed"
  no price information at all -> price null,   qualifier null

Where a range or a minimum is given, price is always the LOWER bound. Never
average a range, and never use the upper bound.

Mandatory warnings. These are not optional colour, they are how the person
reading the result knows which numbers to distrust. Emit one short warning
string, in plain language, for EVERY one of these that applies:

  - the OC fee was stated for any period other than weekly and you converted it
  - any field was inferred from context rather than read directly off the page
  - the page looked truncated, blocked, or was missing a section you expected

Emit an empty array only when none of those applies. A converted fee with no
warning is a defect, even when the arithmetic is right.

Do NOT warn that the price was a range or a minimum. priceQualifier already
carries that, structurally and more reliably than prose, and the UI shows it
from there. A warning saying the same thing just prints it on screen twice.

OC fee conversion. Listings quote this per quarter far more often than per
week, so getting the divisor right matters more than any other arithmetic on
this page. Use exactly these, then round to a whole dollar:

  per week      -> use as-is
  per quarter   -> divide by 13      (a quarter is 13 weeks, NOT 4.33)
  per month     -> multiply by 12, then divide by 52
  per year      -> divide by 52
  per half-year -> divide by 26

Worked example, follow this shape: "$1,180 per quarter" is 1180 / 13 = 90.77,
so ocFeePerWeek is 91. Answering 272 there would be wrong by a factor of 3,
because 4.33 is weeks per month, not weeks per quarter.

Never invent a value that isn't stated or directly computable from a stated
value. Missing information is null, not a guess.`

export const handler = async (event) => {
  // Authorization already happened: under AuthType: AWS_IAM an unsigned or
  // unauthorized request is refused by Lambda at 403 and never reaches this
  // line. What is left is attribution -- WHICH signed-in user this is -- and
  // IAM cannot supply that over a Function URL (see the file header). So the
  // caller's id_token is verified here, before anything is fetched or sent to
  // Bedrock, and a request that cannot be attributed is refused rather than
  // recorded as nobody.
  let userPoolSub
  try {
    userPoolSub = await verifyCallerToken(event)
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'bench-extract identity rejected',
        reason: err?.reason ?? 'unknown',
      }),
    )
    return jsonResponse(401, { error: 'Missing or invalid identity token.' })
  }

  // Per-user quotas are deferred, so this line is what answers "who" when the
  // invocation alarm fires, and it is what makes those quotas addable later
  // without a second cutover.
  console.log(JSON.stringify({ msg: 'bench-extract invocation', userPoolSub }))

  let body
  try {
    body = parseBody(event)
  } catch {
    return jsonResponse(400, { error: 'Request body must be JSON.' })
  }

  const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : null
  const rawText =
    typeof body.rawText === 'string' && body.rawText.trim() ? body.rawText.trim() : null

  if (!url && !rawText) {
    return jsonResponse(400, { error: 'Provide either a listing url or rawText.' })
  }

  let pageText
  if (url) {
    let fetched
    try {
      fetched = await fetchListingPage(url)
    } catch (err) {
      // A rejected URL is the caller's mistake (400); anything else is the
      // upstream site failing on us (502).
      if (err.statusCode === 400) return jsonResponse(400, { error: err.message })
      // Both allowlisted sites block server-side fetching outright (see the
      // allowlist comment above), so in practice this is not a transient
      // upstream blip and "retry" is not useful advice. Say what actually
      // works instead, and hand the UI a stable code so it can switch to the
      // paste step without string-matching this sentence. The raw upstream
      // status stays on `detail` for debugging, out of the user's way.
      return jsonResponse(502, {
        error:
          'Domain and realestate.com.au block automated fetching. Paste the listing text instead.',
        code: 'URL_FETCH_BLOCKED',
        detail: err.message,
      })
    }
    pageText = extractReadableText(fetched)
  } else {
    pageText = rawText
  }

  pageText = pageText.slice(0, MAX_PAGE_TEXT_CHARS)

  let extracted
  try {
    extracted = await extractListingFacts(pageText)
  } catch (err) {
    return jsonResponse(422, {
      error: err.message || 'Could not extract structured details from this listing.',
    })
  }

  return jsonResponse(200, validateExtraction(extracted))
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf-8')
    : event.body || '{}'
  const parsed = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
  return parsed
}

// Thrown by verifyCallerToken. `reason` is a short machine-readable tag for
// the log line and never carries any part of the token: an id_token is a
// bearer credential and also holds the user's email address, so neither it nor
// a verifier message that might quote its claims goes anywhere near the logs.
class CallerTokenError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'CallerTokenError'
    this.reason = reason
  }
}

// Built on first use rather than at module load, so importing this file (the
// unit tests do) needs no environment and makes no network call. The instance
// is kept at module scope because aws-jwt-verify caches the pool's JWKS on it:
// that is one JWKS fetch per cold start, not one per invocation.
let cachedVerifier = null
function defaultVerifier() {
  if (!cachedVerifier) {
    cachedVerifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      clientId: USER_POOL_CLIENT_ID,
      // Checked, not assumed, so a Cognito access token for the same user
      // cannot be passed off as an id_token. `aud` is checked against
      // clientId by the same call.
      tokenUse: 'id',
    })
  }
  return cachedVerifier
}

// Who is calling, from the id_token in x-bench-id-token.
//
// This throws where the readCallerIdentity it replaces returned nulls, and the
// change is the point rather than a side effect. A null sub is
// indistinguishable from a caller who simply left the header off, so a log
// line that tolerates one cannot be trusted and a quota built on it could be
// opted out of by anyone already holding the role. IAM has decided the call is
// allowed; this decides whose budget it lands on, and an unattributable call
// is refused rather than recorded as nobody.
//
// The verifier is a parameter so tests can supply one primed with a local
// JWKS. Production passes nothing and gets the module-scope instance, which is
// resolved only after the header check below: a call with no token is refused
// without ever needing pool configuration or a JWKS.
export async function verifyCallerToken(event, verifier = null) {
  const headers = event?.headers ?? {}
  // Function URLs lowercase incoming header names, but a client signing by
  // hand can send any case and that should not become a 401 nobody can
  // explain.
  const key = Object.keys(headers).find((h) => h.toLowerCase() === ID_TOKEN_HEADER)
  const token = key ? headers[key] : null
  if (!token) throw new CallerTokenError('missing-header')

  let payload
  try {
    payload = await (verifier ?? defaultVerifier()).verify(token)
  } catch (err) {
    // constructor.name, not err.name: aws-jwt-verify subclasses Error without
    // setting the name property, so err.name reads "Error" for every failure
    // and tells you nothing. The constructor is the specific one
    // (JwtExpiredError, CognitoJwtInvalidClientIdError, ...). The message is
    // deliberately not carried: it quotes claim values back at you.
    throw new CallerTokenError(err?.constructor?.name ?? 'verify-failed')
  }

  if (typeof payload?.sub !== 'string' || !payload.sub) throw new CallerTokenError('no-sub')
  return payload.sub
}

// Throws a 400-flagged error (rather than the 502 an upstream failure gets)
// so a caller pasting the wrong link is told what's wrong, not handed a
// generic "could not fetch".
export function assertAllowedUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw clientError('That does not look like a URL. Paste a full listing link, or the page text.')
  }

  if (parsed.protocol !== 'https:') {
    throw clientError(`Listing URLs must be https, not ${parsed.protocol.replace(':', '')}.`)
  }

  // URL already lowercases the hostname, so an exact match is enough. Match
  // the host exactly rather than by suffix: an endsWith check would also
  // accept notdomain.com.au and evil-domain.com.au.
  if (!ALLOWED_LISTING_HOSTS.includes(parsed.hostname)) {
    throw clientError(
      `${parsed.hostname} is not a supported listing site. Paste a link from ${ALLOWED_LISTING_HOSTS.join(' / ')}, or paste the page text instead.`,
    )
  }

  return parsed
}

function clientError(message) {
  const err = new Error(message)
  err.statusCode = 400
  return err
}

async function fetchListingPage(url) {
  // Checked here rather than in the handler so the restriction travels with
  // the fetch, so a future second call site can't skip it by accident.
  assertAllowedUrl(url)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!res.ok) throw new Error(`upstream returned ${res.status}`)

    // A listing page is tens to low hundreds of KB. Anything past 2MB is not
    // a listing, and buffering it costs memory and time for nothing.
    //
    // Two paths, because a chunked response declares no length at all:
    // reject up front when the server tells us the size, otherwise count
    // bytes as they arrive and bail mid-stream. Note that a missing header
    // reads as null, and Number(null) is 0, which is finite -- so the
    // presence check has to be explicit rather than folded into isFinite.
    const declaredHeader = res.headers.get('content-length')
    if (declaredHeader !== null) {
      const declaredBytes = Number(declaredHeader)
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PAGE_BYTES) {
        throw new Error(
          `page is ${Math.round(declaredBytes / 1024 / 1024)}MB, over the ${MAX_PAGE_BYTES / 1024 / 1024}MB limit`,
        )
      }
      return await res.text()
    }

    return await readCapped(res)
  } finally {
    clearTimeout(timer)
  }
}

// Read a response that declared no content-length, counting bytes as they
// arrive and giving up once the running total passes the same 2MB ceiling.
// Bailing mid-stream matters more than the check itself: it means an
// oversized body is never fully buffered, so memory stays bounded whatever
// the server sends. cancel() releases the socket instead of leaving it to
// drain in the background.
async function readCapped(res) {
  if (!res.body) return ''

  const reader = res.body.getReader()
  const chunks = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      total += value.byteLength
      if (total > MAX_PAGE_BYTES) {
        throw new Error(
          `page passed the ${MAX_PAGE_BYTES / 1024 / 1024}MB limit while streaming (no content-length given)`,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  return Buffer.concat(chunks).toString('utf-8')
}

// Pull title/meta description/og: tags to the front (often carry a concise
// price/address summary), strip script/style blocks, strip remaining tags,
// collapse whitespace. A naive regex strip is fine here: this is a best-
// effort text extraction feeding an LLM, not a rendering pipeline.
export function extractReadableText(html) {
  const metaBits = []

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch) metaBits.push(decodeEntities(titleMatch[1].trim()))

  const metaTagRe = /<meta\s+[^>]*>/gi
  const metaTags = html.match(metaTagRe) || []
  for (const tag of metaTags) {
    const nameMatch = tag.match(/(?:name|property)=["']([^"']+)["']/i)
    const contentMatch = tag.match(/content=["']([^"']*)["']/i)
    if (!nameMatch || !contentMatch) continue
    const name = nameMatch[1].toLowerCase()
    if (name === 'description' || name.startsWith('og:')) {
      metaBits.push(decodeEntities(contentMatch[1].trim()))
    }
  }

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  body = decodeEntities(body).replace(/\s+/g, ' ').trim()

  return [...metaBits, body].filter(Boolean).join('\n\n')
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

async function extractListingFacts(pageText) {
  const first = await callBedrock(buildUserMessage(pageText))
  const firstParsed = tryParseJson(first)
  if (firstParsed) return firstParsed

  const retry = await callBedrock(
    buildUserMessage(pageText) +
      '\n\nYour last response was not valid JSON. Return ONLY the JSON object, no prose, no markdown fences.',
  )
  const retryParsed = tryParseJson(retry)
  if (retryParsed) return retryParsed

  throw new Error('Could not extract structured details from this listing.')
}

function buildUserMessage(pageText) {
  return `${EXTRACTION_PROMPT}\n\n---\nPage text:\n${pageText}`
}

function tryParseJson(text) {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(stripped)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

async function callBedrock(userMessage) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BEDROCK_TIMEOUT_MS)
  try {
    const response = await bedrock.send(
      new ConverseCommand({
        modelId: BEDROCK_MODEL_ID,
        messages: [{ role: 'user', content: [{ text: userMessage }] }],
        // The JSON contract is small, but a listing with several warnings can
        // run past 512 and get truncated mid-object, which reads as invalid
        // JSON and burns the retry below on a response that was fine. 1024 is
        // still far under the model's output ceiling.
        inferenceConfig: { maxTokens: 1024 },
      }),
      { abortSignal: controller.signal },
    )
    const text = response.output?.message?.content?.[0]?.text
    if (typeof text !== 'string') throw new Error('Bedrock response had no text content')
    return text
  } finally {
    clearTimeout(timer)
  }
}

// Coerce or null out anything malformed rather than trusting model output
// blindly. Missing evidence is null, never a guess, the same rule this repo
// applies to Turf's hand-maintained records.
export function validateExtraction(raw) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  // Every numeric field here is a count, a price or a fee, so a negative is
  // never a real reading, only a parse gone wrong. Null beats passing it
  // through: the review panel shows an empty field the user can fill, whereas
  // -1 beds looks like data and would reach the value comparison.
  const nonNeg = (v) => {
    const n = num(v)
    return n !== null && n >= 0 ? n : null
  }

  // Rounded here as well as asked for in the prompt, so the stored figure is
  // whole dollars whether or not the model complied. A weekly OC fee carried
  // to the cent is false precision on a converted quarterly number.
  const weeklyFee = nonNeg(raw.ocFeePerWeek)

  // Housing stock, not arbitrary years. The upper bound allows off-the-plan
  // listings, which legitimately advertise a completion year a few years out.
  const year = num(raw.buildYear)
  const plausibleYear =
    year !== null && year >= 1800 && year <= new Date().getUTCFullYear() + 5 ? year : null

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w) => typeof w === 'string')
    : []

  // Structured rather than left to the warnings prose, because the prose is
  // exactly what proved unreliable: a prompt change once silently stopped the
  // model mentioning that a price was a range floor, and nothing downstream
  // could tell. An enum either arrives valid or becomes null, and the UI can
  // key off it. Anything outside the enum is dropped, not passed through.
  const PRICE_QUALIFIERS = ['exact', 'range', 'offers-over', 'auction', 'undisclosed']
  const priceQualifier = PRICE_QUALIFIERS.includes(raw.priceQualifier) ? raw.priceQualifier : null

  return {
    address: str(raw.address),
    suburb: str(raw.suburb),
    price: nonNeg(raw.price),
    priceQualifier,
    beds: nonNeg(raw.beds),
    baths: nonNeg(raw.baths),
    carSpace: str(raw.carSpace),
    ocFeePerWeek: weeklyFee === null ? null : Math.round(weeklyFee),
    buildYear: plausibleYear,
    confidence: raw.confidence === 'high' || raw.confidence === 'low' ? raw.confidence : 'low',
    warnings,
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }
}
