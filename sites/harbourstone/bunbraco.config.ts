import { redirects } from '@bunbraco/simple-redirects'
import { defineConfig } from 'bunbraco'

export default defineConfig({
  siteName: 'Harbourstone Distillery',
  // Installing a bundle gives you its backoffice screen. This line is what lets
  // its endpoints answer a request, so remove it to turn one off.
  bundles: [redirects()],
})
