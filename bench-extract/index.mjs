// lambda/bench-extract/index.mjs
//
// Bench's listing-extraction Lambda. Request/response shapes and the
// extraction prompt are a fixed contract with the frontend's add-listing
// flow (src/components/bench/AddListingFlow.vue) — do not change field names
// on either side without updating both.
//
// Calls Claude via Amazon Bedrock, not the direct Anthropic API: auth is IAM
// (the function's execution role, granted bedrock:InvokeModel in
// template.yaml), so there is no static API key to store, leak, or rotate at
// all. The one declared dependency (@aws-sdk/client-bedrock-runtime) is the
// official AWS SDK, a materially different supply-chain risk than a random
// npm package.
//
// The Function URL itself has no AWS-level auth (see template.yaml) — CORS
// only stops browser callers, not bots hitting it directly — so every
// request must carry the shared-secret x-bench-token header checked below.

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'

const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID
const BENCH_ACCESS_TOKEN = process.env.BENCH_ACCESS_TOKEN
const MAX_PAGE_TEXT_CHARS = 15000
const FETCH_TIMEOUT_MS = 8000
const BEDROCK_TIMEOUT_MS = 10000

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION })

const EXTRACTION_PROMPT = `You extract structured facts from an Australian real-estate listing page.
Input is raw page text (may include navigation cruft, ads, agent bios —
ignore anything not describing the property itself).

Return ONLY a JSON object with exactly these keys, no prose, no markdown fences:
{
  "address": string | null,       // street address, no suburb/state/postcode
  "suburb": string | null,
  "price": number | null,         // AUD, numeric only (e.g. 565000). If a range
                                   // or "offers over X", use the lower bound.
  "beds": number | null,
  "baths": number | null,
  "carSpace": string | null,      // short free text, e.g. "2 (stacker)", "1 (titled)"
  "ocFeePerWeek": number | null,  // owners corp / strata fee per week, AUD. Convert
                                   // quarterly/annual figures to a weekly figure.
  "buildYear": number | null,
  "confidence": "high" | "low",   // "low" if the page looks incomplete, blocked,
                                   // or you had to infer rather than read a field directly
  "warnings": string[]            // short notes, e.g. "OC fee given as annual, converted"
}

Never invent a value that isn't stated or directly computable from a stated
value. Missing information is null, not a guess.`

export const handler = async (event) => {
  const providedToken = findHeader(event, 'x-bench-token')
  if (!BENCH_ACCESS_TOKEN || providedToken !== BENCH_ACCESS_TOKEN) {
    return jsonResponse(401, { error: 'Unauthorized' })
  }

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
      return jsonResponse(502, { error: `Could not fetch that URL: ${err.message}` })
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

// Function URL events lowercase header names in practice, but that isn't a
// documented guarantee — check case-insensitively rather than trusting it.
function findHeader(event, name) {
  const headers = event.headers || {}
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : undefined
}

async function fetchListingPage(url) {
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
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// Pull title/meta description/og: tags to the front (often carry a concise
// price/address summary), strip script/style blocks, strip remaining tags,
// collapse whitespace. A naive regex strip is fine here — this is a best-
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
      '\n\nYour last response was not valid JSON — return ONLY the JSON object, no prose, no markdown fences.',
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
        inferenceConfig: { maxTokens: 512 },
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
// blindly — missing evidence is null, never a guess, same rule this repo
// applies to Turf's hand-maintained records.
export function validateExtraction(raw) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((w) => typeof w === 'string') : []

  return {
    address: str(raw.address),
    suburb: str(raw.suburb),
    price: num(raw.price),
    beds: num(raw.beds),
    baths: num(raw.baths),
    carSpace: str(raw.carSpace),
    ocFeePerWeek: num(raw.ocFeePerWeek),
    buildYear: num(raw.buildYear),
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
