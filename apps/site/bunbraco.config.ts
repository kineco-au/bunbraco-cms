import { redirects } from '@bunbraco/bundle-redirects'
import { bedrock, defineConfig } from 'bunbraco'

/** The reference site. Everything unset here comes from the environment or a default. */

/**
 * The assistant is off unless a model is named, so having AWS credentials in your
 * environment for something else never quietly turns on an AI feature.
 *
 * Credentials are resolved by the AWS SDK's usual chain, so `AWS_PROFILE` works as
 * it does everywhere else. Put both in `.env`, which is gitignored and which Bun
 * and Docker Compose both read. See the README.
 */
const model = Bun.env.BUNBRACO_ASSISTANT_MODEL

export default defineConfig({
  siteName: 'Bunbraco',
  /**
   * The redirects bundle's server half. Installing the package puts its screen in
   * the backoffice; this line is what lets it answer a request, and it is here
   * rather than discovered precisely so that a bundle cannot start serving
   * without someone committing it (`docs/17-bundles.md`).
   */
  bundles: [redirects()],
  assistant: model
    ? {
        provider: bedrock({ model }),
        // Serves the tool layer to Claude Code and Claude Desktop as well.
        mcp: Bun.env.BUNBRACO_ASSISTANT_MCP !== 'false',
      }
    : undefined,
})
