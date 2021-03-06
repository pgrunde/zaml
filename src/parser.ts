import {
  Pos,
  unexp,
  Schema,
  ZamlError,
  brackets,
  whitespace,
  reservedOps,
  BLOCKABLE_TYPES,
  trailingWhitespace
} from './util'

type Statement = {
  pos: Pos
  type: 'pre-statement'
  name: string
  args: string
  argsPos: [Pos,Pos]
  block?: Statement[]
}

type ParseResult = any

export type ParseOptions = {
  /** Variables to make available for interpolation within Zaml source code. */
  vars?: Record<string,string>,
  /** If set to true, parsing will fail when a user tries to use a variable that does not exist. */
  failOnUndefinedVars?: boolean,
}

export function lex (source: string, pos: Pos, inBlock=false): Statement[] {
  var results: Statement[] = []

  while (pos.i < source.length) {
    let i = pos.i
    let c = source[i]

    if (c === '}') {
      if (! inBlock) {
        throw new ZamlError('syntax-error', pos, unexp(c))
      }
      return results
    }

    // Handle whitespace
    if (pos.skipWhitespace(source)) {
      continue
    }

    // Comments
    if (c === '#') {
      while(pos.i < source.length && source[pos.i] !== '\n') {
        pos.newcol()
      }
      continue
    }

    // Reserve key operators
    if (reservedOps.test(c)) {
      throw new ZamlError('syntax-error', pos, `Character ${c} is reserved for key names`)
    }

    // Whitelist errors
    if (brackets.test(c)) {
      throw new ZamlError('syntax-error', pos, unexp(c))
    }

    // Special character escapes
    if (c === '\\' && source[pos.i+1] === '$') {
      // Skip ahead one char, effectively removing the backslash from the key name.
      pos.newcol()
    }

    //
    // Begin statement
    //
    let statementPos = pos.copy()
    let name = readWord(source, pos)

    while (pos.i < source.length && pos.skipSpace(source)) {}

    let argsPosStart = pos.copy()
    //
    // Read rest of the line
    //
    let argsPosEnd = argsPosStart
    while (pos.i < source.length) {
      let c2 = source[pos.i]
      if (c2 === '\n') {
        argsPosEnd = pos.copy()
        pos.newline(source[pos.i+1] === '\r')
        break
      }
      else {
        pos.newcol()
      }
    }
    if (pos.i === source.length) { argsPosEnd = pos.copy() }

    let hasBlock = source[argsPosEnd.i-1] === '{'
    if (hasBlock) {
      // Backtrack
      argsPosEnd.i -= 1
      argsPosEnd.col -= 1
    }

    let args = source.substring(argsPosStart.i, argsPosEnd.i).replace(trailingWhitespace, '')

    let s: Statement = {
      pos: statementPos,
      type: 'pre-statement',
      name: name,
      args: args,
      argsPos: [argsPosStart, argsPosEnd],
    }
    if (hasBlock) {
      s.block = lex(source, pos, true)
      if (pos.i === source.length) {
        throw new ZamlError('syntax-error', pos, `Unexpected EOF: Missing end bracket '}'`)
      }
      if (source[pos.i] !== '}') {
        throw new ZamlError('syntax-error', pos,
          `Expected end bracket '}', got ${JSON.stringify(source[pos.i])} instead (shouldn't be possible?)`)
      }
      pos.newcol()
    }

    results.push(s)
  }
  return results
}

export function parseZaml (source: string, blockSchema: Schema.Block, statements: Statement[], opts: ParseOptions): ParseResult {
  var result: any = blockSchema.type === 'array' ? [] : {}

  if (blockSchema.type === 'hash') {
    for (let name in blockSchema.schema) {
      if (blockSchema.schema[name].multi) {
        result[name] = []
      }
    }
  }

  for (var i=0; i < statements.length; i++) {
    const s = statements[i]
    const name = s.name
    const t = blockSchema.schema[name]

    if ( ! t ) {
      throw new ZamlError('user-error', s.pos, `No such config key: ${name}`)
    }

    let parsedValue: any

    if (t.type === 'num') {
      let num = Number(withVars(s.args, s.pos, opts))
      if (Number.isNaN(num)) {
        throw new ZamlError('user-error', s.argsPos[0], `Invalid number: '${s.args}'`)
      }
      parsedValue = num
    }
    else if (t.type === 'str') {
      parsedValue = withVars(s.args, s.pos, opts)
    }
    else if (t.type === 'bool') {
      let val = withVars(s.args, s.pos, opts)
      if (val === '') {
        throw new ZamlError('user-error', s.argsPos[0], `Boolean '${val} requires a value.'`)
      }
      if (val !== 'true' && val !== 'false') {
        throw new ZamlError('user-error', s.argsPos[0],
          `Invalid boolean: '${val}'. Value must be true or false.`)
      }
      parsedValue = val === 'true'
    }
    else if (t.type === 'list') {
      if (s.block) {
        // Block list
        if (s.args.length > 0) {
          throw new ZamlError('user-error', s.argsPos[0], listFormatError)
        }

        let list = []
        for (let s2 of s.block) {
          if (t.block) {
            let str = withVars(s2.name, s2.pos, opts)
            list.push(s2.block ? [str, parseZaml(source, t.block, s2.block, opts)] : [str])
          }
          else if (s2.block) {
            throw new ZamlError('user-error', s2.argsPos[0], `The '${s.name}' list does not accept a block.`)
          }
          else {
            list.push(
              withVars(s2.name + (s2.args.length ? ` ${s2.args}` : ''), s2.pos, opts)
            )
          }
        }
        parsedValue = list
      }
      else {
        // Inline list
        parsedValue = parseArgs(source, s.argsPos[0], s.argsPos[1], opts)
      }
    }
    else if (t.type === 'kv') {
      var hash: Record<string,string> = {}
      if (s.block) {
        for (let s2 of s.block) {
          if (s2.args === '') {
            throw new ZamlError('user-error', s2.argsPos[0], `Hash key '${s2.name}' requires a value.`)
          }
          hash[ withVars(s2.name, s2.pos, opts)] = withVars(s2.args, s2.argsPos[0], opts)
        }
      }
      parsedValue = hash
    }
    else if (t.type === 'hash' || t.type === 'array') {
      if (! s.block) {
        throw new ZamlError('user-error', s.pos, `Key '${s.name}' requires a block.`)
      }
      parsedValue = parseZaml(source, t, s.block, opts)
    }
    else if (t.type === 'tuple') {
      let args = parseArgs(source, s.argsPos[0], s.argsPos[1], opts, (arg, k, pos) => {
        if (k >= t.schema.length) {
          let types = t.schema.map(t => t.type).join(' ')
          throw new ZamlError('user-error', pos,
            `Too many arguments; tuple only accepts ${types}`)
        }
        let t2 = t.schema[k]
        //
        // No need to transform with withVars at this point since
        // parseArgs has already done so.
        //
        if (t2.type === 'num') {
          return Number(arg)
        }
        else if (t2.type === 'str') {
          return arg
        }
        else if (t2.type === 'bool') {
          if (arg !== 'true' && arg !== 'false') {
            throw new ZamlError('user-error', pos,
              `Invalid boolean: '${arg}'. Value must be true or false.`)
          }
          return arg === 'true'
        }
        else {
          throw new ZamlError('unexpected-error', pos,
            `Invalid tuple type '${JSON.stringify(t2)}' for arg '${JSON.stringify(arg)}' (Shouldn't be possible)`)
        }
      })

      if (args.length !== t.schema.length) {
        let types = t.schema.map(t => t.type).join(', ')
        throw new ZamlError('user-error', s.pos,
          `Incorrect number of arguments. Key '${s.name}' expects ${types}.`)
      }

      parsedValue = args
    }
    else {
      throw new ZamlError('unexpected-error', null, `Invalid type object (${JSON.stringify(t)})`)
    }

    //
    // Handle blocks
    //
    if (s.block && BLOCKABLE_TYPES.indexOf(t.type) >= 0 && t.type !== 'list') {
      let innerBlockSchema = ('block' in t) && t.block
      if (! innerBlockSchema) {
        throw new ZamlError('user-error', s.argsPos[1], `Key ${s.name} does not accept a block.`)
      }
      else {
        parsedValue = [parsedValue, parseZaml(source, innerBlockSchema, s.block, opts)]
      }
    }

    if (blockSchema.type === 'array') {
      result.push([name, parsedValue])
    }
    else if (t.multi) {
      result[name].push(parsedValue)
    }
    else {
      if (name in result) {
        throw new ZamlError('user-error', s.pos,
          `Duplicate key '${name}'. This key may only be specified once in this context.`)
      }
      result[name] = parsedValue
    }
  }

  return result
}

function parseQuotedString (source: string, pos: Pos, end: Pos): string {
  var start = pos.copy()
  // TODO: Support backslash quotes
  while (pos.i < end.i && source[pos.i] !== '"') {
    if (pos.skipNewline(source)) {
      throw new ZamlError('syntax-error', pos, `Newlines are not allowed in quoted strings`)
    }
    pos.newcol()
  }
  if (pos.i === end.i) {
    throw new ZamlError('syntax-error', start, `Unexpected EOF: Missing end quote`)
  }
  var str = source.substring(start.i, pos.i)
  pos.newcol() // Skip end quote character
  return str
}

function parseArgs (
  source: string,
  start: Pos,
  end: Pos,
  opts: ParseOptions,
  map: (arg: string, i: number, pos: Pos) => any = id
): string[] {
  var args: string[] = []
  var pos = start.copy()

  while (pos.i < end.i) {
    let c = source[pos.i]

    // Quoted string
    if (c === '"') {
      let start = pos.copy()
      let arg = parseQuotedString(source, pos.newcol(), end)
      args.push(map(withVars(arg, start, opts), args.length, start))
    }

    // Unquoted string
    else {
      let start = pos.copy()
      while (pos.i < end.i && source[pos.i] !== ',' && source[pos.i] !== '\n') {
        pos.newcol()
      }
      let arg = source.substring(start.i, pos.i).trim()
      args.push(map(withVars(arg, start, opts), args.length, start))
    }

    while (pos.skipSpace(source)) {}

    let c2 = source[pos.i]
    if (c2 === '\n' || c2 === '{' && source[pos.i+1] === '\n') {
      return args
    }
    if (c2 === ',') {
      let commaPos = pos.copy()
      pos.newcol()
      while (pos.skipSpace(source)) {}

      if (pos.i === source.length || source[pos.i] === '\n') {
        throw new ZamlError('syntax-error', commaPos, `Unexpected comma`)
      }
      continue
    }
    throw new ZamlError('syntax-error', pos, unexp(c2, ' (did you forget a comma?)'))
  }

  return args
}

function readWord (source: string, pos: Pos): string {
  var start = pos.i
  while (pos.i < source.length && ! whitespace.test(source[pos.i])) {
    pos.newcol()
  }
  return source.substring(start, pos.i)
}

function withVars (str: string, origin: Pos, opts: ParseOptions) {
  if (! opts.vars) return str

  return str.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, varName) => {
    var val = opts.vars![varName]
    if ( ! val && opts.failOnUndefinedVars === true) {
      throw new ZamlError('user-error', origin, `Variable '$${varName}' is not defined.`)
    }
    return val || ''
  })
}

function id <T>(x: T) { return x }

const listFormatError =
  `You may provide a block or inline arguments to a list, but not both.
Examples:
  ✓ a_list x y z
  ✓ a_list {
      x
      y
      z
    }
`
