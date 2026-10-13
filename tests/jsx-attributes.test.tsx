/**
 * The JSX runtime against what a React author writes: attribute names and
 * values, form controls, children it cannot render, and the doctype.
 */
import { describe, expect, test } from 'bun:test'
import { withDoctype } from '@bunbraco/render'
import { type Child, renderToString } from '@bunbraco/render/jsx-runtime'

const html = (node: unknown) => renderToString(node as Child) as string
const later = <T,>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 1))

describe('attribute names', () => {
  test('are written as the attribute React would write', () => {
    expect(
      html(
        <label className="a" htmlFor="b">
          Name
        </label>,
      ),
    ).toBe('<label class="a" for="b">Name</label>')
    expect(html(<meta httpEquiv="refresh" />)).toBe('<meta http-equiv="refresh" />')
    expect(html(<form acceptCharset="utf-8" />)).toBe('<form accept-charset="utf-8"></form>')
    expect(
      html(
        <svg viewBox="0 0 1 1" xmlnsXlink="http://www.w3.org/1999/xlink">
          <title>Icon</title>
          <path strokeWidth={2} fillRule="evenodd" strokeLinecap="round" />
          <use xlinkHref="#icon" />
        </svg>,
      ),
    ).toBe(
      '<svg viewBox="0 0 1 1" xmlns:xlink="http://www.w3.org/1999/xlink"><title>Icon</title><path stroke-width="2" fill-rule="evenodd" stroke-linecap="round"></path><use xlink:href="#icon"></use></svg>',
    )
  })

  test('leave a camelCase HTML attribute alone, which HTML reads whatever its case', () => {
    expect(html(<input tabIndex={-1} readOnly maxLength={5} />)).toBe(
      '<input tabIndex="-1" readOnly maxLength="5" />',
    )
  })

  test('drop ref and key, which are never attributes', () => {
    expect(html(<div key="k" ref={{ current: null }} id="x" />)).toBe('<div id="x"></div>')
  })

  test('refuse a name that is not one, so data spread into an element cannot inject', () => {
    const fromData = { 'x" onload="alert(1)': 'v' }
    expect(() => <div {...fromData} />).toThrow('is not a valid attribute name')
  })
})

describe('attribute values', () => {
  test('a style object is CSS, with px where React adds it', () => {
    expect(
      html(
        <div
          style={{
            marginTop: 4,
            zIndex: 2,
            opacity: 0.5,
            padding: 0,
            lineHeight: 1.5,
            WebkitTransition: 'none',
            msTransform: 'none',
            '--gap': 3,
            color: null,
            fontFamily: '"Inter", sans-serif',
          }}
        />,
      ),
    ).toBe(
      '<div style="margin-top:4px;z-index:2;opacity:0.5;padding:0;line-height:1.5;-webkit-transition:none;-ms-transform:none;--gap:3;font-family:&quot;Inter&quot;, sans-serif"></div>',
    )
    expect(html(<div style={{}} />)).toBe('<div></div>')
    expect(html(<div style="color: red" />)).toBe('<div style="color: red"></div>')
  })

  test('aria-*, data-* and the boolean-like attributes write true and false as text', () => {
    expect(
      html(
        <button type="button" aria-expanded={false} data-open={false} draggable>
          Menu
        </button>,
      ),
    ).toBe(
      '<button type="button" aria-expanded="false" data-open="false" draggable="true">Menu</button>',
    )
    expect(html(<span aria-hidden={true} />)).toBe('<span aria-hidden="true"></span>')
  })

  test('any other boolean is present or absent, as before', () => {
    expect(html(<input disabled={true} required={false} />)).toBe('<input disabled />')
  })

  test('a function is refused, because a static page cannot run it', () => {
    expect(() => (
      // @ts-expect-error A handler is a type error too, matching what the runtime does.
      <button type="button" onClick={() => {}}>
        Go
      </button>
    )).toThrow(
      'The "onClick" attribute of <button> is a function. Pages are rendered to static HTML, so it can never run. Render an element to mount on, and load your client code from /scripts/.',
    )
  })

  test('an object with no text of its own is refused; one with text is written', () => {
    expect(() => <div title={{ a: 1 } as never} />).toThrow(
      'The "title" attribute of <div> is an object',
    )
    expect(() => <div title={Symbol('s') as never} />).toThrow('is a symbol')
    expect(html(<div data-list={['a', 'b']} />)).toBe('<div data-list="a,b"></div>')
    expect(html(<a href={new URL('https://example.com/x') as never}>x</a>)).toBe(
      '<a href="https://example.com/x">x</a>',
    )
  })
})

describe('dangerouslySetInnerHTML', () => {
  test('is written verbatim, as React writes it', async () => {
    expect(html(<div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} />)).toBe(
      '<div><b>x</b></div>',
    )
    expect(
      await renderToString(<div dangerouslySetInnerHTML={{ __html: later('<i>y</i>') }} />),
    ).toBe('<div><i>y</i></div>')
  })

  test('cannot be combined with children or setInnerHTML', () => {
    expect(() => <div dangerouslySetInnerHTML={{ __html: 'x' }}>y</div>).toThrow(
      'both children and dangerouslySetInnerHTML',
    )
    expect(() => (
      <div dangerouslySetInnerHTML={{ __html: 'x' }} setInnerHTML={{ __html: 'y' }} />
    )).toThrow('both setInnerHTML and dangerouslySetInnerHTML')
  })
})

describe('form controls', () => {
  test('an input’s default value and checked state are its value and checked', () => {
    expect(html(<input defaultValue="hi" defaultChecked />)).toBe('<input value="hi" checked />')
    expect(html(<input value="set" defaultValue="ignored" />)).toBe('<input value="set" />')
  })

  test('a textarea’s value is its escaped content', () => {
    expect(html(<textarea name="t" value="<b>" />)).toBe('<textarea name="t">&lt;b&gt;</textarea>')
    expect(html(<textarea defaultValue="d" />)).toBe('<textarea>d</textarea>')
    expect(() => <textarea value="v">c</textarea>).toThrow('both a value and children')
  })

  test('a select’s value marks its options selected, by value or by text', () => {
    expect(
      html(
        <select name="s" value="b">
          <option value="a">A</option>
          <option value="b">B</option>
          <option>c</option>
        </select>,
      ),
    ).toBe(
      '<select name="s"><option value="a">A</option><option value="b" selected>B</option><option>c</option></select>',
    )
    expect(
      html(
        <select defaultValue="c">
          {['a', 'c'].map((v) => (
            <option>{v}</option>
          ))}
        </select>,
      ),
    ).toBe('<select><option>a</option><option selected>c</option></select>')
  })

  test('a multiple select takes a list, and reaches through an optgroup', () => {
    expect(
      html(
        <select multiple value={['a', 'c']}>
          <optgroup label="First">
            <option value="a">A</option>
            <option value="b" selected>
              B
            </option>
          </optgroup>
          <option value="c">C</option>
        </select>,
      ),
    ).toBe(
      '<select multiple><optgroup label="First"><option value="a" selected>A</option><option value="b">B</option></optgroup><option value="c" selected>C</option></select>',
    )
  })

  test('an option whose content is async is waited for', async () => {
    expect(
      await renderToString(
        <select value="x">
          <option value="w">W</option>
          <option value="x">{later('X')}</option>
        </select>,
      ),
    ).toBe('<select><option value="w">W</option><option value="x" selected>X</option></select>')
  })

  test('a value no option it can see has is refused, naming the way round it', () => {
    const Wrapped = () => <option value="b">B</option>
    expect(() => (
      <select value="b">
        {/* biome-ignore lint/complexity/noUselessFragments: a fragment is the point of the test. */}
        <>
          <option value="a">A</option>
        </>
        <Wrapped />
      </select>
    )).toThrow(
      '<select> was given the value "b", but no <option> it can see has it. An option inside a fragment or returned from a component is written before the select can ask it, so put `selected` on that option instead.',
    )
  })
})

describe('children', () => {
  test('numbers, including zero and bigint, are text', () => {
    expect(
      html(
        <p>
          {0}
          {1n as never}
        </p>,
      ),
    ).toBe('<p>01</p>')
  })

  test('an object is refused, saying what was found', () => {
    expect(() => <p>{{ a: 1, b: 2 } as never}</p>).toThrow(
      'Objects are not valid as a child (found: object with keys {a, b})',
    )
    expect(() => <p>{new Date(0) as never}</p>).toThrow('found: [object Date]')
  })

  test('a function is refused, rather than its source printed', () => {
    expect(() => <p>{(() => 'x') as never}</p>).toThrow('A function is not valid as a child')
  })

  test('a React element is refused, pointing at mounting it in the browser', () => {
    const reactElement = {
      $$typeof: Symbol.for('react.transitional.element'),
      type: 'div',
      props: {},
    }
    expect(() => <main>{reactElement as never}</main>).toThrow(
      'A React element was rendered in a page template.',
    )
  })
})

describe('the doctype', () => {
  test('is added to a whole document, and to nothing else', () => {
    expect(withDoctype('<html lang="en"><body></body></html>')).toBe(
      '<!DOCTYPE html><html lang="en"><body></body></html>',
    )
    expect(withDoctype('<HTML>')).toBe('<!DOCTYPE html><HTML>')
    expect(withDoctype('<!DOCTYPE html><html></html>')).toBe('<!DOCTYPE html><html></html>')
    expect(withDoctype('<main>a fragment</main>')).toBe('<main>a fragment</main>')
    expect(withDoctype('<htmlish>')).toBe('<htmlish>')
  })
})
