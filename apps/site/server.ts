import { bunbraco } from 'bunbraco'
import config from './bunbraco.config.ts'

Bun.serve(await bunbraco(config))
