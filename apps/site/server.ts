import { crombolo } from '@crombolo/crombolo'
import config from './crombolo.config.ts'

Bun.serve(await crombolo(config))
