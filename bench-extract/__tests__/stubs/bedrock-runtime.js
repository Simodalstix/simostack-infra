// Test-only stand-in for @aws-sdk/client-bedrock-runtime.
//
// index.mjs imports the SDK at module scope and constructs a client there, so
// importing it in a test needs the specifier to resolve. The SDK is a
// dependency of the Lambda's own package.json, not the site's, and it is not
// installed at the repo root. Aliasing it here keeps the pure functions
// testable without adding a 3MB AWS dependency to the frontend's tree.
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
