#!/usr/bin/env bun
/**
 * The `bunbraco` binary a site gets from the umbrella package.
 *
 * The command line itself lives in `@bunbraco/cli`, which is installable on its
 * own. Both packages declare the same bin name; because this file resolves to
 * the same module the CLI package would have run, whichever one a package
 * manager links is the same command.
 */
import '@bunbraco/cli/bin'
