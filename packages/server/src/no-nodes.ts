/**
 * The holding page for a site with nothing published — Umbraco's "no nodes"
 * screen, which `docs/06-features.md` asks for.
 *
 * It answers 404, not 200: a brand-new site is not a working one, and anything
 * watching the URL should keep saying so until a page is published. It is only
 * reached when the published tree is empty, so a missing path on a live site is
 * the bare 404 it always was.
 */
export function noNodesPage(options: { siteName: string; backOfficePath: string }): string {
  const site = escapeHtml(options.siteName)
  const backoffice = escapeHtml(options.backOfficePath)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${site} — nothing published yet</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f6f5f3; color: #1b1b1b;
  }
  main { max-width: 34rem; padding: 2.5rem 1.5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .75rem; }
  p { margin: 0 0 1rem; }
  ol { margin: 0 0 1.5rem; padding-left: 1.25rem; }
  li { margin-bottom: .35rem; }
  code { font-size: .9em; background: #e9e7e2; padding: .1em .35em; border-radius: 3px; }
  a.cta { display: inline-block; padding: .55rem 1rem; border-radius: 4px; background: #1b1b1b; color: #fff; text-decoration: none; }
  .fine { font-size: .85rem; color: #6b6b63; }
  @media (prefers-color-scheme: dark) {
    body { background: #16171a; color: #e8e6e3; }
    code { background: #26282c; }
    a.cta { background: #e8e6e3; color: #16171a; }
    .fine { color: #9a9a93; }
  }
</style>
</head>
<body>
<main>
  <h1>Nothing is published yet</h1>
  <p>${site} is running. There is no published page for visitors to see, so this is what the site serves.</p>
  <ol>
    <li>Sign in to the backoffice.</li>
    <li>Create a page from one of the document types in <code>schema/</code> — if there are none, add one there first.</li>
    <li>Publish it. This page goes away.</li>
  </ol>
  <p><a class="cta" href="${backoffice}">Open the backoffice</a></p>
  <p class="fine">Served with a 404: nothing is published, and a crawler should be told that plainly.</p>
</main>
</body>
</html>
`
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
