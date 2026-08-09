// Unit tests for the bench-extract Lambda's pure helpers.
//
// validateExtraction is the last thing standing between model output and the
// value comparison, so its job is to distrust that output. These cases are the
// distrust, not the happy path: what happens when a field comes back negative,
// implausible, wrong-typed or missing entirely.

import { describe, it, expect } from 'vitest'
import { validateExtraction, assertAllowedUrl, extractReadableText } from '../index.mjs'

// A complete, well-formed extraction. Individual tests override one field so
// each assertion is about the field it names.
const good = {
  address: '5/210 Toorak Rd',
  suburb: 'South Yarra',
  price: 620000,
  priceQualifier: 'range',
  beds: 2,
  baths: 1,
  carSpace: '1 (titled)',
  ocFeePerWeek: 91,
  buildYear: 2004,
  confidence: 'high',
  warnings: [],
}

describe('validateExtraction', () => {
  it('passes a clean extraction through unchanged', () => {
    expect(validateExtraction(good)).toEqual(good)
  })

  it('nulls negative numbers rather than passing them to the comparison', () => {
    const out = validateExtraction({ ...good, price: -620000, beds: -1, ocFeePerWeek: -50 })
    expect(out.price).toBeNull()
    expect(out.beds).toBeNull()
    expect(out.ocFeePerWeek).toBeNull()
  })

  it('keeps zero, which is a real reading for an OC fee on a house', () => {
    expect(validateExtraction({ ...good, ocFeePerWeek: 0 }).ocFeePerWeek).toBe(0)
  })

  it('rounds the weekly OC fee to whole dollars', () => {
    // 1180/13 = 90.769..., the correct conversion of a $1,180 quarterly fee.
    expect(validateExtraction({ ...good, ocFeePerWeek: 90.769 }).ocFeePerWeek).toBe(91)
    expect(validateExtraction({ ...good, ocFeePerWeek: 272.31 }).ocFeePerWeek).toBe(272)
  })

  it('rejects implausible build years but allows off-the-plan completion', () => {
    expect(validateExtraction({ ...good, buildYear: 1200 }).buildYear).toBeNull()
    expect(validateExtraction({ ...good, buildYear: 20250 }).buildYear).toBeNull()
    expect(validateExtraction({ ...good, buildYear: 1850 }).buildYear).toBe(1850)
    const nextYear = new Date().getUTCFullYear() + 1
    expect(validateExtraction({ ...good, buildYear: nextYear }).buildYear).toBe(nextYear)
  })

  it('nulls wrong-typed fields instead of coercing them', () => {
    const out = validateExtraction({ ...good, price: '620000', beds: null, address: '   ' })
    expect(out.price).toBeNull()
    expect(out.beds).toBeNull()
    expect(out.address).toBeNull()
  })

  it('falls back to low confidence when the model sends something unexpected', () => {
    expect(validateExtraction({ ...good, confidence: 'very high' }).confidence).toBe('low')
    expect(validateExtraction({ ...good, confidence: undefined }).confidence).toBe('low')
  })

  it('always returns a warnings array, whatever arrived', () => {
    expect(validateExtraction({ ...good, warnings: 'oops' }).warnings).toEqual([])
    expect(validateExtraction({ ...good, warnings: ['a', 5, 'b'] }).warnings).toEqual(['a', 'b'])
  })

  it('keeps every valid priceQualifier and drops anything else', () => {
    for (const q of ['exact', 'range', 'offers-over', 'auction', 'undisclosed']) {
      expect(validateExtraction({ ...good, priceQualifier: q }).priceQualifier).toBe(q)
    }
    // A plausible-looking value the model invented is still not in the enum.
    expect(validateExtraction({ ...good, priceQualifier: 'negotiable' }).priceQualifier).toBeNull()
    expect(validateExtraction({ ...good, priceQualifier: 'RANGE' }).priceQualifier).toBeNull()
    expect(validateExtraction({ ...good, priceQualifier: undefined }).priceQualifier).toBeNull()
  })

  it('returns the full shape even from an empty object', () => {
    const out = validateExtraction({})
    expect(Object.keys(out).sort()).toEqual(Object.keys(good).sort())
    expect(out.confidence).toBe('low')
  })
})

describe('assertAllowedUrl', () => {
  it('accepts the allowlisted hosts over https', () => {
    expect(assertAllowedUrl('https://www.domain.com.au/123').hostname).toBe('www.domain.com.au')
    expect(assertAllowedUrl('https://www.realestate.com.au/x').hostname).toBe(
      'www.realestate.com.au',
    )
  })

  it('rejects a lookalike host that a suffix check would let through', () => {
    expect(() => assertAllowedUrl('https://evil-domain.com.au/x')).toThrow(/not a supported/)
    expect(() => assertAllowedUrl('https://domain.com.au.evil.com/x')).toThrow(/not a supported/)
  })

  it('rejects http and non-URLs', () => {
    expect(() => assertAllowedUrl('http://www.domain.com.au/x')).toThrow(/must be https/)
    expect(() => assertAllowedUrl('not a url')).toThrow(/does not look like a URL/)
  })

  it('flags its errors as client errors, so the handler answers 400 not 502', () => {
    expect(() => assertAllowedUrl('https://example.com')).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    )
  })
})

describe('extractReadableText', () => {
  it('lifts the title and meta description ahead of the body', () => {
    const html = `<html><head><title>2 bed in South Yarra</title>
      <meta name="description" content="$620,000 - $660,000">
      </head><body><p>Open plan living</p></body></html>`
    const out = extractReadableText(html)
    expect(out.indexOf('2 bed in South Yarra')).toBeLessThan(out.indexOf('Open plan living'))
    expect(out).toContain('$620,000 - $660,000')
  })

  it('drops script and style content rather than feeding it to the model', () => {
    const html = `<html><body><script>var price = 999999</script>
      <style>.a{color:red}</style><p>Real text</p></body></html>`
    const out = extractReadableText(html)
    expect(out).not.toContain('999999')
    expect(out).not.toContain('color:red')
    expect(out).toContain('Real text')
  })

  it('decodes the entities that show up in listing prices and addresses', () => {
    expect(extractReadableText('<p>Smith &amp; Co&nbsp;&#39;s listing</p>')).toContain(
      "Smith & Co 's listing",
    )
  })
})
