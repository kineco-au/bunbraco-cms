export function SiteFooter({ siteName }: { siteName: string }) {
  return (
    <footer class="site-footer">
      <div class="container">
        <p>{siteName} · Built with Bunbraco</p>
      </div>
    </footer>
  )
}
