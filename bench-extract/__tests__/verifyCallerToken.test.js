// Unit tests for verifyCallerToken, which is how the handler knows WHICH
// signed-in user is calling.
//
// These replace the readCallerIdentity tests, and the reason they do is worth
// keeping: those tests passed against a hand-built event carrying
// requestContext.authorizer.iam.cognitoIdentity, a shape a Function URL
// documents itself as never sending. Green tests, dead code path, and the
// defect only surfaced when a real invocation logged a null sub. So nothing
// here asserts against an invented event shape: the tokens are really signed
// with a real RSA key and really verified through aws-jwt-verify, with the
// JWKS primed locally so no test touches the network.

import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { CognitoJwtVerifier } from 'aws-jwt-verify'
import { verifyCallerToken, handler } from '../index.mjs'

const POOL_ID = 'ap-southeast-2_eDQvUrDb3'
const CLIENT_ID = '7omtia4riv4qnpqs4bdtmv5e6i'
const ISS = `https://cognito-idp.ap-southeast-2.amazonaws.com/${POOL_ID}`
const SUB = '4f8a1c2e-9b3d-4a1e-8c7f-2d6b0e5a9317'
const KID = 'test-key-1'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
// A second, unrelated key: signing with it produces a token that is
// structurally perfect and cryptographically wrong, which is the case a
// shape-only test can never catch.
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey

const verifier = CognitoJwtVerifier.create({
  userPoolId: POOL_ID,
  clientId: CLIENT_ID,
  tokenUse: 'id',
})
verifier.cacheJwks({
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }],
})

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

function signToken(claims = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000)
  const data = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64({
    sub: SUB,
    iss: ISS,
    aud: CLIENT_ID,
    token_use: 'id',
    iat: now,
    exp: now + 3600,
    email: 'someone@example.com',
    ...claims,
  })}`
  return `${data}.${createSign('RSA-SHA256').update(data).end().sign(key).toString('base64url')}`
}

const eventWith = (headers) => ({ headers })

describe('verifyCallerToken', () => {
  it('returns the sub from a genuine id_token', async () => {
    const event = eventWith({ 'x-bench-id-token': signToken() })
    await expect(verifyCallerToken(event, verifier)).resolves.toBe(SUB)
  })

  it('matches the header name case-insensitively', async () => {
    // Function URLs lowercase header names, but a hand-rolled SigV4 client can
    // send any case and that must not become an unexplainable 401.
    const event = eventWith({ 'X-Bench-Id-Token': signToken() })
    await expect(verifyCallerToken(event, verifier)).resolves.toBe(SUB)
  })

  it('rejects a request with no token, without needing a verifier at all', async () => {
    // No verifier argument on purpose: a headerless call must be refused
    // before any pool configuration or JWKS is required. In this test process
    // USER_POOL_ID is unset, so building one would throw something other than
    // a CallerTokenError.
    for (const event of [eventWith({}), {}, undefined]) {
      await expect(verifyCallerToken(event)).rejects.toMatchObject({
        name: 'CallerTokenError',
        reason: 'missing-header',
      })
    }
  })

  it('rejects a token signed by the wrong key', async () => {
    const event = eventWith({ 'x-bench-id-token': signToken({}, otherKey) })
    await expect(verifyCallerToken(event, verifier)).rejects.toMatchObject({
      name: 'CallerTokenError',
    })
  })

  it('rejects an expired token, and names the reason usefully', async () => {
    // The reason is the verifier's constructor name, not err.name:
    // aws-jwt-verify never sets the name property, so reading it would tag
    // every distinct failure as a useless "Error" in the logs.
    const past = Math.floor(Date.now() / 1000) - 7200
    const event = eventWith({ 'x-bench-id-token': signToken({ iat: past, exp: past + 3600 }) })
    await expect(verifyCallerToken(event, verifier)).rejects.toMatchObject({
      name: 'CallerTokenError',
      reason: 'JwtExpiredError',
    })
  })

  it('rejects a token minted for a different client of the same pool', async () => {
    const event = eventWith({ 'x-bench-id-token': signToken({ aud: 'some-other-client-id' }) })
    await expect(verifyCallerToken(event, verifier)).rejects.toMatchObject({
      name: 'CallerTokenError',
    })
  })

  it('rejects a token from a different user pool', async () => {
    const event = eventWith({
      'x-bench-id-token': signToken({
        iss: 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_XXXXXXXXX',
      }),
    })
    await expect(verifyCallerToken(event, verifier)).rejects.toMatchObject({
      name: 'CallerTokenError',
    })
  })

  it('refuses an access token passed off as an id_token', async () => {
    // Same pool, same user, same signature -- only token_use differs. This is
    // why tokenUse is verified rather than assumed.
    const event = eventWith({
      'x-bench-id-token': signToken({ token_use: 'access', client_id: CLIENT_ID }),
    })
    await expect(verifyCallerToken(event, verifier)).rejects.toMatchObject({
      name: 'CallerTokenError',
    })
  })

  it('never puts the token or its claims in the error it throws', async () => {
    // The error's reason is logged. An id_token is a bearer credential and
    // carries the user's email, so neither may travel in it.
    const token = signToken({}, otherKey)
    const err = await verifyCallerToken(eventWith({ 'x-bench-id-token': token }), verifier).catch(
      (e) => e,
    )
    const serialised = `${err.name} ${err.reason} ${err.message}`
    expect(serialised).not.toContain(token)
    expect(serialised).not.toContain('someone@example.com')
    expect(serialised).not.toContain(SUB)
  })
})

describe('handler identity gate', () => {
  it('401s an unattributable request before doing any work', async () => {
    // Fail closed: IAM says the caller may invoke, but nothing says who they
    // are, so the call is refused rather than logged as nobody. The body is
    // valid on purpose -- what is being tested is that identity is checked
    // first, ahead of parsing, fetching or Bedrock.
    const res = await handler({
      headers: {},
      body: JSON.stringify({ rawText: 'a listing that would otherwise be extracted' }),
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toMatch(/identity token/i)
  })
})
