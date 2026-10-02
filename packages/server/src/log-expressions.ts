/**
 * The filter language of Umbraco's log viewer: Serilog.Expressions, over
 * events read from the log files. This covers what the viewer's saved
 * searches and its filter box use — `@Level`, `@Message`, `@MessageTemplate`,
 * `@Exception`, `@Timestamp` and properties (with `.member`, `[n]` and the
 * any-element wildcard `[?]`), comparisons, `like`, `in`, `is [not] null`,
 * `and`/`or`/`not`, the `ci` modifier, and the functions `Has`, `Not`,
 * `StartsWith`, `EndsWith`, `Contains`, `IndexOf`, `Length`, `ToLower`,
 * `ToUpper`. As in Serilog, a missing property is undefined, and only a result
 * that is exactly true matches.
 */

/** An event as the filter sees it. */
export interface LogEvent {
  timestamp: string
  level: string
  messageTemplate: string
  message: string
  exception: string | null
  properties: Record<string, unknown>
}

type Node =
  | { kind: 'literal'; value: unknown }
  | { kind: 'name'; name: string }
  | { kind: 'member'; target: Node; name: string }
  | { kind: 'index'; target: Node; index: Node | 'any' }
  | { kind: 'call'; name: string; args: Node[]; ci: boolean }
  | { kind: 'unary'; op: 'not' | '-'; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node; ci: boolean }
  | { kind: 'is'; operand: Node; negated: boolean }
  | { kind: 'array'; items: Node[] }

/** A value that stands for "any element of" a collection, from `[?]`. */
class AnyOf {
  constructor(readonly values: unknown[]) {}
}

const UNDEFINED = undefined

type Token = { type: 'num' | 'str' | 'id' | 'op' | 'punct'; value: string }

function tokenize(source: string): Token[] | undefined {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i] as string
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    if (c === "'") {
      let value = ''
      i += 1
      for (;;) {
        if (i >= source.length) return undefined
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            value += "'"
            i += 2
            continue
          }
          i += 1
          break
        }
        value += source[i]
        i += 1
      }
      tokens.push({ type: 'str', value })
      continue
    }
    const number = /^\d+(\.\d+)?/.exec(source.slice(i))
    if (number) {
      tokens.push({ type: 'num', value: number[0] })
      i += number[0].length
      continue
    }
    const identifier = /^@?[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))
    if (identifier) {
      tokens.push({ type: 'id', value: identifier[0] })
      i += identifier[0].length
      continue
    }
    const operator = /^(<>|<=|>=|=|<|>|\+|-|\*|\/|%)/.exec(source.slice(i))
    if (operator) {
      tokens.push({ type: 'op', value: operator[0] })
      i += operator[0].length
      continue
    }
    if ('()[],.?'.includes(c)) {
      tokens.push({ type: 'punct', value: c })
      i += 1
      continue
    }
    return undefined
  }
  return tokens
}

class Parser {
  #tokens: Token[]
  #at = 0

  constructor(tokens: Token[]) {
    this.#tokens = tokens
  }

  get done() {
    return this.#at >= this.#tokens.length
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#at]
  }

  #keyword(word: string): boolean {
    const token = this.#peek()
    if (token?.type === 'id' && token.value.toLowerCase() === word) {
      this.#at += 1
      return true
    }
    return false
  }

  #punct(value: string): boolean {
    const token = this.#peek()
    if (token?.type === 'punct' && token.value === value) {
      this.#at += 1
      return true
    }
    return false
  }

  #expect(value: string) {
    if (!this.#punct(value)) throw new SyntaxError(`Expected '${value}'`)
  }

  expression(): Node {
    return this.#or()
  }

  #or(): Node {
    let left = this.#and()
    while (this.#keyword('or'))
      left = { kind: 'binary', op: 'or', left, right: this.#and(), ci: false }
    return left
  }

  #and(): Node {
    let left = this.#not()
    while (this.#keyword('and'))
      left = { kind: 'binary', op: 'and', left, right: this.#not(), ci: false }
    return left
  }

  #not(): Node {
    const token = this.#peek()
    const next = this.#tokens[this.#at + 1]
    // `not` as an operator, not the `Not(...)` function
    if (
      token?.type === 'id' &&
      token.value.toLowerCase() === 'not' &&
      !(next?.type === 'punct' && next.value === '(' && token.value === 'Not')
    ) {
      this.#at += 1
      return { kind: 'unary', op: 'not', operand: this.#not() }
    }
    return this.#comparison()
  }

  #comparison(): Node {
    let left = this.#additive()
    for (;;) {
      const token = this.#peek()
      if (token?.type === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(token.value)) {
        this.#at += 1
        const right = this.#additive()
        left = { kind: 'binary', op: token.value, left, right, ci: this.#keyword('ci') }
        continue
      }
      if (this.#keyword('is')) {
        const negated = this.#keyword('not')
        if (!this.#keyword('null')) throw new SyntaxError('Expected null')
        left = { kind: 'is', operand: left, negated }
        continue
      }
      const save = this.#at
      const negated = this.#keyword('not')
      if (this.#keyword('like')) {
        const right = this.#additive()
        const like: Node = { kind: 'binary', op: 'like', left, right, ci: this.#keyword('ci') }
        left = negated ? { kind: 'unary', op: 'not', operand: like } : like
        continue
      }
      if (this.#keyword('in')) {
        const right = this.#additive()
        const within: Node = { kind: 'binary', op: 'in', left, right, ci: this.#keyword('ci') }
        left = negated ? { kind: 'unary', op: 'not', operand: within } : within
        continue
      }
      this.#at = save
      return left
    }
  }

  #additive(): Node {
    let left = this.#multiplicative()
    for (;;) {
      const token = this.#peek()
      if (token?.type === 'op' && (token.value === '+' || token.value === '-')) {
        this.#at += 1
        left = { kind: 'binary', op: token.value, left, right: this.#multiplicative(), ci: false }
      } else return left
    }
  }

  #multiplicative(): Node {
    let left = this.#unary()
    for (;;) {
      const token = this.#peek()
      if (token?.type === 'op' && ['*', '/', '%'].includes(token.value)) {
        this.#at += 1
        left = { kind: 'binary', op: token.value, left, right: this.#unary(), ci: false }
      } else return left
    }
  }

  #unary(): Node {
    const token = this.#peek()
    if (token?.type === 'op' && token.value === '-') {
      this.#at += 1
      return { kind: 'unary', op: '-', operand: this.#unary() }
    }
    return this.#postfix(this.#primary())
  }

  #postfix(node: Node): Node {
    let current = node
    for (;;) {
      if (this.#punct('.')) {
        const name = this.#peek()
        if (name?.type !== 'id') throw new SyntaxError('Expected a member name')
        this.#at += 1
        current = { kind: 'member', target: current, name: name.value }
      } else if (this.#punct('[')) {
        if (this.#punct('?')) {
          this.#expect(']')
          current = { kind: 'index', target: current, index: 'any' }
        } else {
          const index = this.expression()
          this.#expect(']')
          current = { kind: 'index', target: current, index }
        }
      } else return current
    }
  }

  #primary(): Node {
    const token = this.#peek()
    if (!token) throw new SyntaxError('Unexpected end')
    this.#at += 1
    if (token.type === 'num') return { kind: 'literal', value: Number(token.value) }
    if (token.type === 'str') return { kind: 'literal', value: token.value }
    if (token.type === 'punct' && token.value === '(') {
      const inner = this.expression()
      this.#expect(')')
      return inner
    }
    if (token.type === 'punct' && token.value === '[') {
      const items: Node[] = []
      if (!this.#punct(']')) {
        do items.push(this.expression())
        while (this.#punct(','))
        this.#expect(']')
      }
      return { kind: 'array', items }
    }
    if (token.type === 'id') {
      const lower = token.value.toLowerCase()
      if (lower === 'true') return { kind: 'literal', value: true }
      if (lower === 'false') return { kind: 'literal', value: false }
      if (lower === 'null') return { kind: 'literal', value: null }
      if (this.#punct('(')) {
        const args: Node[] = []
        if (!this.#punct(')')) {
          do args.push(this.expression())
          while (this.#punct(','))
          this.#expect(')')
        }
        return { kind: 'call', name: token.value.toLowerCase(), args, ci: this.#keyword('ci') }
      }
      return { kind: 'name', name: token.value }
    }
    throw new SyntaxError(`Unexpected '${token.value}'`)
  }
}

const BUILT_INS: Record<string, keyof LogEvent> = {
  '@l': 'level',
  '@level': 'level',
  '@m': 'message',
  '@message': 'message',
  '@mt': 'messageTemplate',
  '@messagetemplate': 'messageTemplate',
  '@x': 'exception',
  '@exception': 'exception',
  '@t': 'timestamp',
  '@timestamp': 'timestamp',
}

const text = (value: unknown, ci: boolean) =>
  typeof value === 'string' ? (ci ? value.toLowerCase() : value) : value

function equal(a: unknown, b: unknown, ci: boolean): boolean {
  if (typeof a === 'string' && typeof b === 'string') return text(a, ci) === text(b, ci)
  if (a === null || b === null) return a === b
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return a === b
}

function like(value: unknown, pattern: unknown, ci: boolean): boolean | undefined {
  if (typeof value !== 'string' || typeof pattern !== 'string') return UNDEFINED
  const regex = pattern
    .split('')
    .map((c) => (c === '%' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${regex}$`, ci ? 'is' : 's').test(value)
}

/** Applies `op` to each element of an any-of operand; true when any is. */
function anyOf(left: unknown, right: unknown, op: (l: unknown, r: unknown) => unknown): unknown {
  if (left instanceof AnyOf) return left.values.some((l) => op(l, right) === true)
  if (right instanceof AnyOf) return right.values.some((r) => op(left, r) === true)
  return op(left, right)
}

function evaluate(node: Node, event: LogEvent): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'array':
      return node.items.map((item) => evaluate(item, event))
    case 'name': {
      const builtIn = BUILT_INS[node.name.toLowerCase()]
      if (builtIn) return event[builtIn] ?? UNDEFINED
      if (node.name.toLowerCase() === '@p' || node.name.toLowerCase() === '@properties')
        return event.properties
      return node.name in event.properties ? event.properties[node.name] : UNDEFINED
    }
    case 'member': {
      const target = evaluate(node.target, event)
      if (target && typeof target === 'object' && node.name in target)
        return (target as Record<string, unknown>)[node.name]
      return UNDEFINED
    }
    case 'index': {
      const target = evaluate(node.target, event)
      if (node.index === 'any') return Array.isArray(target) ? new AnyOf(target) : UNDEFINED
      const index = evaluate(node.index, event)
      if (Array.isArray(target) && typeof index === 'number') return target[index]
      if (target && typeof target === 'object' && typeof index === 'string')
        return (target as Record<string, unknown>)[index]
      return UNDEFINED
    }
    case 'is': {
      const value = evaluate(node.operand, event)
      const isNull = value === null || value === UNDEFINED
      return node.negated ? !isNull : isNull
    }
    case 'unary': {
      const value = evaluate(node.operand, event)
      if (node.op === '-') return typeof value === 'number' ? -value : UNDEFINED
      return typeof value === 'boolean' ? !value : UNDEFINED
    }
    case 'binary': {
      if (node.op === 'and') {
        const left = evaluate(node.left, event)
        if (left === false) return false
        const right = evaluate(node.right, event)
        if (right === false) return false
        return left === true && right === true ? true : UNDEFINED
      }
      if (node.op === 'or') {
        const left = evaluate(node.left, event)
        if (left === true) return true
        const right = evaluate(node.right, event)
        if (right === true) return true
        return left === false && right === false ? false : UNDEFINED
      }
      const left = evaluate(node.left, event)
      const right = evaluate(node.right, event)
      return anyOf(left, right, (l, r) => {
        if (l === UNDEFINED || r === UNDEFINED) return UNDEFINED
        switch (node.op) {
          case '=':
            return equal(l, r, node.ci)
          case '<>':
            return !equal(l, r, node.ci)
          case 'like':
            return like(l, r, node.ci)
          case 'in':
            return Array.isArray(r) ? r.some((item) => equal(l, item, node.ci)) : UNDEFINED
          default:
            break
        }
        const comparable =
          (typeof l === 'number' && typeof r === 'number') ||
          (typeof l === 'string' && typeof r === 'string')
        if (!comparable) return UNDEFINED
        const a = l as number | string
        const b = r as number | string
        switch (node.op) {
          case '<':
            return a < b
          case '<=':
            return a <= b
          case '>':
            return a > b
          case '>=':
            return a >= b
          case '+':
            return typeof a === 'number' && typeof b === 'number' ? a + b : `${a}${b}`
          case '-':
            return typeof a === 'number' && typeof b === 'number' ? a - b : UNDEFINED
          case '*':
            return typeof a === 'number' && typeof b === 'number' ? a * b : UNDEFINED
          case '/':
            return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : UNDEFINED
          case '%':
            return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a % b : UNDEFINED
          default:
            return UNDEFINED
        }
      })
    }
    case 'call': {
      const args = node.args.map((arg) => evaluate(arg, event))
      const [first, second] = args
      switch (node.name) {
        case 'has':
        case 'isdefined':
          return first instanceof AnyOf
            ? first.values.length > 0
            : first !== UNDEFINED && first !== null
        case 'not':
          return typeof first === 'boolean' ? !first : UNDEFINED
        case 'startswith':
          return anyOf(first, second, (a, b) =>
            typeof a === 'string' && typeof b === 'string'
              ? (text(a, node.ci) as string).startsWith(text(b, node.ci) as string)
              : UNDEFINED,
          )
        case 'endswith':
          return anyOf(first, second, (a, b) =>
            typeof a === 'string' && typeof b === 'string'
              ? (text(a, node.ci) as string).endsWith(text(b, node.ci) as string)
              : UNDEFINED,
          )
        case 'contains':
          return anyOf(first, second, (a, b) =>
            typeof a === 'string' && typeof b === 'string'
              ? (text(a, node.ci) as string).includes(text(b, node.ci) as string)
              : UNDEFINED,
          )
        case 'indexof':
          return anyOf(first, second, (a, b) =>
            typeof a === 'string' && typeof b === 'string'
              ? (text(a, node.ci) as string).indexOf(text(b, node.ci) as string)
              : UNDEFINED,
          )
        case 'length':
          return typeof first === 'string' || Array.isArray(first) ? first.length : UNDEFINED
        case 'tolower':
          return typeof first === 'string' ? first.toLowerCase() : UNDEFINED
        case 'toupper':
          return typeof first === 'string' ? first.toUpperCase() : UNDEFINED
        default:
          throw new SyntaxError(`Unknown function '${node.name}'`)
      }
    }
  }
}

/** A compiled expression, or undefined when it is not one — which the viewer turns into a text search. */
export function compileExpression(source: string): ((event: LogEvent) => boolean) | undefined {
  const tokens = tokenize(source)
  if (!tokens || tokens.length === 0) return undefined
  let tree: Node
  try {
    const parser = new Parser(tokens)
    tree = parser.expression()
    if (!parser.done) return undefined
    // An unknown function is a compile error in Serilog, so find one now
    evaluate(tree, {
      timestamp: '',
      level: '',
      messageTemplate: '',
      message: '',
      exception: null,
      properties: {},
    })
  } catch {
    return undefined
  }
  return (event) => {
    try {
      return evaluate(tree, event) === true
    } catch {
      return false
    }
  }
}

/**
 * Umbraco's filter: a single word with no operator characters, or anything that
 * does not compile, is a search for that text in the rendered message.
 */
export function logFilter(expression: string | null | undefined): (event: LogEvent) => boolean {
  const source = expression?.trim() ?? ''
  if (!source) return () => true
  const plainWord = !/\s/.test(source) && !/[()+=*<>%-]/.test(source)
  const compiled = plainWord ? undefined : compileExpression(source)
  return compiled ?? ((event) => event.message.includes(source))
}
