/**
 * Story 091: the plain-text part an e-mail template's HTML is sent with.
 */
import { describe, expect, test } from 'bun:test'
import { htmlToText } from '@crombolo/server'

describe('htmlToText', () => {
  test('paragraphs and headings are separated by a blank line', () => {
    expect(htmlToText('<h1>Thanks</h1><p>We have your message.</p><p>Talk soon.</p>')).toBe(
      'Thanks\n\nWe have your message.\n\nTalk soon.',
    )
  })

  test('a table row is a line, its cells spaced apart', () => {
    expect(
      htmlToText(
        '<table><tr><th>Name</th><td>Ada</td></tr><tr><th>Topic</th><td>Sales</td></tr></table>',
      ),
    ).toBe('Name  Ada\nTopic  Sales')
  })

  test('list items read as dashes', () => {
    expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toBe('- One\n- Two')
  })

  test('a link keeps its address, once', () => {
    expect(htmlToText('<p>See <a href="https://example.com/a?b=1&amp;c=2">the page</a></p>')).toBe(
      'See the page (https://example.com/a?b=1&c=2)',
    )
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe(
      'https://example.com',
    )
    expect(htmlToText('<a href="mailto:a@example.com">a@example.com</a>')).toBe('a@example.com')
    // A link to somewhere on the page has no address worth reading.
    expect(htmlToText('<a href="#top">Top</a>')).toBe('Top')
  })

  test('the head, styles, scripts and comments are dropped', () => {
    expect(
      htmlToText(
        '<!DOCTYPE html><html><head><title>Receipt</title><style>p { margin: 0 }</style></head>' +
          '<body><!-- hidden --><script>alert(1)</script><p>Shown</p></body></html>',
      ),
    ).toBe('Shown')
  })

  test('entities are decoded and runs of space collapse', () => {
    expect(
      htmlToText('<p>Fish &amp; chips&nbsp;&nbsp;for &#163;5 &#x2014;   &lt;today&gt;</p>'),
    ).toBe('Fish & chips for £5 — <today>')
  })

  test('a line break breaks the line, and blank lines never pile up', () => {
    expect(htmlToText('<div>1 High St<br>Hobart</div><p></p><p></p><div><p>End</p></div>')).toBe(
      '1 High St\nHobart\n\nEnd',
    )
  })
})
