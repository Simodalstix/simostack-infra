// Test-only stand-in for @aws-sdk/client-bedrock-runtime.
//
// index.mjs imports the SDK at module scope and constructs a client there, so
// importing it in a test pulls the SDK in whether or not the test touches
// Bedrock. Aliasing it to this file (see vitest.config.js) keeps the pure
// functions testable without the real client.
//
// The real SDK is a declared dependency of this package and would resolve on
// its own, so the alias is about isolation rather than resolution: the tests
// stay hermetic, and a test that starts calling Bedrock fails on the throw
// below instead of quietly trying to reach AWS. This reasoning was different
// while the Lambda lived in vue-simostack, where the SDK was not installed at
// all and the alias was the only thing making the import resolve.
//
// Nothing here is exercised: these tests only cover functions that never call
// Bedrock. If a test ever needs a real Converse response, give the stub a
// send() that returns a canned payload rather than reaching for the SDK.

export class BedrockRuntimeClient {
  constructor(config) {
    this.config = config
  }

  send() {
    throw new Error('BedrockRuntimeClient.send is not stubbed. These tests should not call it.')
  }
}

export class ConverseCommand {
  constructor(input) {
    this.input = input
  }
}
