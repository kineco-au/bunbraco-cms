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
  assistant: model
    ? {
        provider: bedrock({ model }),
        // Serves the tool layer to Claude Code and Claude Desktop as well.
        mcp: Bun.env.BUNBRACO_ASSISTANT_MCP !== 'false',
      }
    : undefined,
})
