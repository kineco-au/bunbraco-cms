/**
 * The rich text editor's "embed" dialog asks the server for a URL's embed
 * markup (Umbraco's `OEmbedService`). These are Umbraco's providers, each asked
 * for JSON; a photo becomes an `<img>`, anything else is the provider's HTML.
 */

interface Provider {
  name: string
  endpoint: string
  patterns: RegExp[]
}

export const OEMBED_PROVIDERS: readonly Provider[] = [
  {
    name: 'YouTube',
    endpoint: 'https://www.youtube.com/oembed',
    patterns: [
      /^https?:\/\/(www\.)?youtu\.be\//,
      /^https?:\/\/(www\.)?youtube\.com\/watch/,
      /^https?:\/\/(www\.)?youtube\.com\/shorts\//,
      /^https?:\/\/(www\.)?youtube\.com\/live\//,
    ],
  },
  {
    name: 'Vimeo',
    endpoint: 'https://vimeo.com/api/oembed.json',
    patterns: [/^https?:\/\/(www\.)?vimeo\.com\//],
  },
  {
    name: 'X',
    endpoint: 'https://publish.x.com/oembed',
    patterns: [/^https?:\/\/(www\.)?(twitter|x)\.com\/[^/]+\/status\//],
  },
  {
    name: 'DailyMotion',
    endpoint: 'https://www.dailymotion.com/services/oembed',
    patterns: [/^https?:\/\/(www\.)?dailymotion\.com\/video\//],
  },
  {
    name: 'Flickr',
    endpoint: 'https://www.flickr.com/services/oembed/',
    patterns: [/^https?:\/\/(www\.)?flickr\.com\/photos\//, /^https?:\/\/flic\.kr\/p\//],
  },
  {
    name: 'GettyImages',
    endpoint: 'https://embed.gettyimages.com/oembed',
    patterns: [/^https?:\/\/(www\.)?gty\.im\//, /^https?:\/\/(www\.)?gettyimages\.com\/detail\//],
  },
  {
    name: 'Giphy',
    endpoint: 'https://giphy.com/services/oembed',
    patterns: [/^https?:\/\/(www\.)?giphy\.com\//, /^https?:\/\/(www\.)?gph\.is\//],
  },
  {
    name: 'Hulu',
    endpoint: 'https://www.hulu.com/api/oembed.json',
    patterns: [/^https?:\/\/(www\.)?hulu\.com\/watch\//],
  },
  {
    name: 'Issuu',
    endpoint: 'https://issuu.com/oembed',
    patterns: [/^https?:\/\/(www\.)?issuu\.com\/[^/]+\/docs\//],
  },
  {
    name: 'Kickstarter',
    endpoint: 'https://www.kickstarter.com/services/oembed',
    patterns: [/^https?:\/\/(www\.)?kickstarter\.com\/projects\//],
  },
  {
    name: 'LottieFiles',
    endpoint: 'https://embed.lottiefiles.com/oembed',
    patterns: [/^https?:\/\/(www\.)?lottiefiles\.com\//],
  },
  {
    name: 'Slideshare',
    endpoint: 'https://www.slideshare.net/api/oembed/2',
    patterns: [/^https?:\/\/(www\.)?slideshare\.net\//],
  },
  {
    name: 'SoundCloud',
    endpoint: 'https://soundcloud.com/oembed',
    patterns: [/^https?:\/\/(www\.)?soundcloud\.com\//],
  },
  {
    name: 'Ted',
    endpoint: 'https://www.ted.com/services/v1/oembed.json',
    patterns: [/^https?:\/\/(www\.)?ted\.com\/talks\//],
  },
]

export type OEmbedResult =
  | { ok: true; markup: string }
  | { ok: false; status: 'unsupported' | 'failed'; reason: string }

const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

export function createOEmbedService(fetcher: typeof fetch = fetch) {
  return {
    async markup(url: string, maxWidth?: number, maxHeight?: number): Promise<OEmbedResult> {
      const provider = OEMBED_PROVIDERS.find((p) => p.patterns.some((pattern) => pattern.test(url)))
      if (!provider)
        return {
          ok: false,
          status: 'unsupported',
          reason: 'No oEmbed provider was found for the specified url.',
        }
      const request = new URL(provider.endpoint)
      request.searchParams.set('url', url)
      request.searchParams.set('format', 'json')
      if (maxWidth) request.searchParams.set('maxwidth', String(maxWidth))
      if (maxHeight) request.searchParams.set('maxheight', String(maxHeight))
      let body: Record<string, unknown>
      try {
        const response = await fetcher(request, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`${provider.name} answered ${response.status}`)
        body = (await response.json()) as Record<string, unknown>
      } catch (error) {
        return {
          ok: false,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
      if (body.type === 'photo' && typeof body.url === 'string')
        return {
          ok: true,
          markup: `<img src="${escapeAttribute(body.url)}" width="${escapeAttribute(String(body.width ?? ''))}" height="${escapeAttribute(String(body.height ?? ''))}" alt="${escapeAttribute(String(body.title ?? ''))}" />`,
        }
      if (typeof body.html === 'string') return { ok: true, markup: body.html }
      return {
        ok: false,
        status: 'failed',
        reason: `${provider.name} returned no embeddable markup.`,
      }
    },
  }
}

export type OEmbedService = ReturnType<typeof createOEmbedService>
