#!/usr/bin/env bun
/**
 * The crombolo CLI. Runs from a site directory and reads `crombolo.config.ts`
 * there when present. Each command is a class under `src/commands/`; `crombolo
 * --help` lists them, and `crombolo schema` describes them for a machine.
 */
import { main } from '../src/main.ts'

await main(import.meta.url)
