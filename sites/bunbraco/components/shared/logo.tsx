/**
 * The Bunbraco mark: a baked bun with a "b" set into it.
 *
 * One string, so the inline logo and the favicon cannot drift apart. The letter
 * is drawn as shapes rather than set in a font, so it looks the same whether or
 * not a rounded face is installed.
 */
const MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="16 21 168 168" aria-hidden="true">' +
  '<ellipse cx="100" cy="105" rx="78" ry="58" fill="#c17a4a"/>' +
  '<path d="M48 95Q55 70 80 72" fill="none" stroke="#e8c9a0" stroke-width="4" stroke-linecap="round" opacity="0.6"/>' +
  '<path d="M42 105Q48 85 70 82" fill="none" stroke="#f5e0c0" stroke-width="3" stroke-linecap="round" opacity="0.4"/>' +
  '<path d="M83 87V135M88 120a15 15 0 1 0 30 0a15 15 0 1 0-30 0" fill="none" stroke="#fbf7f2" stroke-width="12" stroke-linecap="round"/>' +
  '</svg>'

export const FAVICON = `data:image/svg+xml,${encodeURIComponent(MARK)}`

export function Logo({ size }: { size?: 'large' }) {
  return (
    <span
      class={size === 'large' ? 'mark mark--large' : 'mark'}
      setInnerHTML={{ __html: MARK, dangerously: true }}
    />
  )
}
