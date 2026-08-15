import { fileURLToPath, URL } from 'node:url'
import { defineConfig, configDefaults } from 'vitest/config'

// Test config for this service only. Each service owns its own package.json
// and its own runner, matching how they deploy: separately, by hand, with no
// root stack tying them together. There is deliberately no npm workspace at
// the repo root, because workspaces hoist node_modules upward and `sam build`
// expects this directory's dependencies to be resolvable from this directory.
export default defineConfig({
  test: {
    // `sam build` copies the whole CodeUri, __tests__ included, into
    // .aws-sam/build/BenchExtractFunction/. Without this, vitest discovers
    // that copy as well as the real file and runs every test twice. It is
    // worse than double-counting: the copy is a snapshot from whenever
    // sam build last ran, so once the source moves on it fails against code
    // nobody is editing, in a gitignored directory that does not show up in
    // git status. Spread the defaults rather than replacing them, or this
    // silently re-enables node_modules and dist.
    exclude: [...configDefaults.exclude, '**/.aws-sam/**'],
    alias: {
      // Swaps the real Bedrock client for a stub. The stub file itself says
      // why; do not restate it here, or the two copies will disagree.
      '@aws-sdk/client-bedrock-runtime': fileURLToPath(
        new URL('./__tests__/stubs/bedrock-runtime.js', import.meta.url),
      ),
    },
  },
})
