/**
 * What the site's files say, when the backup has them: the Razor views, the
 * media, and the evidence of packages and custom code that a database cannot
 * give.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface SiteFiles {
  root: string
  /** `Views/**` Razor files, relative to the directory that holds `Views`. */
  razor: Array<{ path: string; file: string; lines: number; uses: string[] }>
  /** The directory media keys resolve under, when one was found. */
  mediaDir?: string
  /** NuGet packages the project references, as `Name Version`. */
  packages: string[]
  /** Directories under `App_Plugins`. */
  plugins: string[]
  /** `.cs` files outside build output. */
  csharp: number
  /** Stylesheets and scripts under the web root, relative to it. */
  assets: Array<{ path: string; file: string }>
}

const SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', 'umbraco'])

function walk(dir: string, visit: (file: string) => void, depth = 0): void {
  if (depth > 12 || !existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path, visit, depth + 1)
    } else if (entry.isFile()) visit(path)
  }
}

/** The directory, at or below `root`, that directly contains `name`. */
function findParentOf(root: string, name: string, depth = 0): string | undefined {
  if (existsSync(join(root, name)) && statSync(join(root, name)).isDirectory()) return root
  if (depth > 3) return undefined
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue
    const found = findParentOf(join(root, entry.name), name, depth + 1)
    if (found) return found
  }
  return undefined
}

const slashes = (path: string): string => path.split(sep).join('/')

/** Razor features that mean more than markup has to be rewritten. */
const RAZOR_USES: Array<[label: string, pattern: RegExp]> = [
  ['partials', /Html\.(Partial|RenderPartial|CachedPartial)|<partial\b/],
  ['view components', /Component\.InvokeAsync|<vc:/],
  ['forms', /Html\.BeginUmbracoForm|BeginForm|asp-action/],
  ['macros', /RenderMacro|Umbraco\.RenderMacro/],
  ['block rendering', /GetBlockListHtml|GetBlockGridHtml/],
  ['injected services', /@inject\b/],
  ['dictionary', /GetDictionaryValue/],
]

export function readSiteFiles(root: string, mediaOverride?: string): SiteFiles {
  if (!existsSync(root)) throw new Error(`No site directory at ${root}.`)

  const webRoot = findParentOf(root, 'Views') ?? root
  const razor: SiteFiles['razor'] = []
  walk(join(webRoot, 'Views'), (file) => {
    if (!file.endsWith('.cshtml')) return
    const text = readFileSync(file, 'utf8')
    razor.push({
      path: slashes(relative(webRoot, file)),
      file,
      lines: text.split('\n').length,
      uses: RAZOR_USES.filter(([, pattern]) => pattern.test(text)).map(([label]) => label),
    })
  })

  const wwwroot = findParentOf(root, 'wwwroot')
  const publicDir = wwwroot ? join(wwwroot, 'wwwroot') : webRoot
  const mediaDir =
    mediaOverride ?? (existsSync(join(publicDir, 'media')) ? join(publicDir, 'media') : undefined)

  const assets: SiteFiles['assets'] = []
  for (const folder of ['css', 'scripts', 'js']) {
    walk(join(publicDir, folder), (file) => {
      if (/\.(css|js)$/.test(file)) assets.push({ path: slashes(relative(publicDir, file)), file })
    })
  }

  const packages = new Set<string>()
  let csharp = 0
  walk(root, (file) => {
    if (file.endsWith('.cs')) csharp++
    if (!file.endsWith('.csproj')) return
    const xml = readFileSync(file, 'utf8')
    for (const match of xml.matchAll(
      /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g,
    ))
      packages.add(match[2] ? `${match[1]} ${match[2]}` : (match[1] as string))
  })

  const pluginsParent = findParentOf(root, 'App_Plugins')
  const plugins = pluginsParent
    ? readdirSync(join(pluginsParent, 'App_Plugins'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : []

  return {
    root,
    razor: razor.sort((a, b) => a.path.localeCompare(b.path)),
    mediaDir: mediaDir && existsSync(mediaDir) ? mediaDir : undefined,
    packages: [...packages].sort(),
    plugins: plugins.sort(),
    csharp,
    assets: assets.sort((a, b) => a.path.localeCompare(b.path)),
  }
}
