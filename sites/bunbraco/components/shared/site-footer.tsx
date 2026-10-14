import type { Navigation } from 'bunbraco'
import { repositoryUrl } from './site.tsx'

export function SiteFooter({ nav }: { nav: Navigation }) {
  return (
    <footer class="site-footer">
      <div class="container">
        <p>Bunbraco: the editing experience your team already knows, on a stack built for today.</p>
        <p>
          Open source, built on the open-source Umbraco back office. ·{' '}
          <a href={repositoryUrl(nav)}>Source on GitHub</a>
        </p>
      </div>
    </footer>
  )
}
