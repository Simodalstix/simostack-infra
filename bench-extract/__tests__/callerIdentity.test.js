// Unit tests for readCallerIdentity, the Phase 2 replacement for the
// x-bench-token check.
//
// The handler no longer authenticates anything -- AuthType: AWS_IAM means an
// unsigned request is refused by Lambda at 403 and never arrives -- so what is
// left to test is not "does it reject", it is "does it read the caller out of
// an event shape nobody controls, and does it stay quiet when the shape is not
// what we expect". These cases are mostly the second thing: a throw here would
// turn a logging detail into a failed extraction for an authorized user.

import { describe, it, expect } from 'vitest'
import { readCallerIdentity } from '../index.mjs'

const POOL = 'cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_eDQvUrDb3'
const SUB = '4f8a1c2e-9b3d-4a1e-8c7f-2d6b0e5a9317'

// The shape a Function URL delivers under IAM auth for an Identity Pool
// principal. amr carries three entries and the sub is inside the third, not a
// field of its own.
const signedEvent = {
  requestContext: {
    authorizer: {
      iam: {
        cognitoIdentity: {
          identityId: 'ap-southeast-2:968e7518-1f4b-4c2a-b0d7-5e3a9c81f204',
          identityPoolId: 'ap-southeast-2:968e7518-1f4b-4c2a-b0d7-5e3a9c81f204',
          amr: ['authenticated', POOL, `${POOL}:CognitoSignIn:${SUB}`],
        },
      },
    },
  },
}

describe('readCallerIdentity', () => {
  it('pulls the identity id and the user pool sub out of a signed event', () => {
    expect(readCallerIdentity(signedEvent)).toEqual({
      identityId: 'ap-southeast-2:968e7518-1f4b-4c2a-b0d7-5e3a9c81f204',
      userPoolSub: SUB,
    })
  })

  it('finds the sub by its marker, not by its position in amr', () => {
    const reordered = structuredClone(signedEvent)
    reordered.requestContext.authorizer.iam.cognitoIdentity.amr = [
      `${POOL}:CognitoSignIn:${SUB}`,
      'authenticated',
    ]
    expect(readCallerIdentity(reordered).userPoolSub).toBe(SUB)
  })

  it('returns nulls rather than throwing on an event with no identity', () => {
    expect(readCallerIdentity({})).toEqual({ identityId: null, userPoolSub: null })
    expect(readCallerIdentity(undefined)).toEqual({ identityId: null, userPoolSub: null })
  })

  it('keeps the identity id when amr carries no CognitoSignIn entry', () => {
    const noSignIn = structuredClone(signedEvent)
    noSignIn.requestContext.authorizer.iam.cognitoIdentity.amr = ['authenticated']
    expect(readCallerIdentity(noSignIn)).toEqual({
      identityId: 'ap-southeast-2:968e7518-1f4b-4c2a-b0d7-5e3a9c81f204',
      userPoolSub: null,
    })
  })

  it('tolerates amr being absent or the wrong type', () => {
    for (const amr of [undefined, null, 'authenticated', {}]) {
      const odd = structuredClone(signedEvent)
      odd.requestContext.authorizer.iam.cognitoIdentity.amr = amr
      expect(readCallerIdentity(odd).userPoolSub).toBeNull()
    }
  })
})
