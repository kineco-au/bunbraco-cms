import { Wordmark } from './site-header.tsx'

export function SiteFooter() {
  return (
    <footer class="site-footer">
      <div class="site-footer__inner">
        <p>
          <Wordmark /> Distillery · Cove of Stenwick, Caithness
        </p>
        <p>A demonstration site. Nothing here is real, and nothing here is for sale.</p>
      </div>
    </footer>
  )
}
