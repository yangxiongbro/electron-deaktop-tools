/** SQL 相关纯函数：格式化、压缩、大小写、去注释、MyBatis 参数解析/填充 */

/** 需要独占一行的「大关键字」 */
const MAJOR_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION ALL',
  'UNION',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'FULL OUTER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'CROSS JOIN',
  'JOIN',
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'WITH'
]

/** 需要缩进一行的连接词 */
const JOIN_WORDS = ['AND', 'OR']

const KEYWORDS = [
  ...MAJOR_KEYWORDS,
  'ON',
  'AS',
  'ASC',
  'DESC',
  'DISTINCT',
  'IN',
  'NOT',
  'NULL',
  'IS',
  'LIKE',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'EXISTS',
  'ALL',
  'ANY',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'IFNULL',
  'COALESCE',
  'NOW',
  'TRUE',
  'FALSE',
  'BY',
  'INTO',
  'DEFAULT',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'INDEX',
  'UNIQUE'
]

const KEYWORD_SET = new Set([...KEYWORDS, ...JOIN_WORDS].map((item) => item.toUpperCase()))
/** 长的优先匹配，避免 JOIN 抢先匹配到 LEFT JOIN */
const MAJOR_SORTED = [...MAJOR_KEYWORDS].sort((left, right) => right.length - left.length)

interface Token {
  type: 'word' | 'string' | 'punct' | 'comment' | 'space'
  value: string
}

/** 粗粒度分词：保留字符串、反引号标识符、注释，其它按字符切开 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  const push = (type: Token['type'], value: string): void => {
    tokens.push({ type, value })
  }

  while (index < sql.length) {
    const char = sql[index]
    const rest = sql.slice(index)

    // 行注释（# 后面跟 { 时是 MyBatis 参数，不是注释）
    if (rest.startsWith('--') || (char === '#' && sql[index + 1] !== '{')) {
      const end = sql.indexOf('\n', index)
      const value = end === -1 ? rest : sql.slice(index, end)
      push('comment', value)
      index += value.length
      continue
    }
    // 块注释
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', index + 2)
      const value = end === -1 ? rest : sql.slice(index, end + 2)
      push('comment', value)
      index += value.length
      continue
    }
    // 单引号字符串
    if (char === "'") {
      let cursor = index + 1
      let value = "'"
      while (cursor < sql.length) {
        const current = sql[cursor]
        value += current
        if (current === "'" ) {
          if (sql[cursor + 1] === "'") {
            value += "'"
            cursor += 2
            continue
          }
          cursor += 1
          break
        }
        cursor += 1
      }
      push('string', value)
      index = cursor
      continue
    }
    // 反引号 / 双引号标识符
    if (char === '`' || char === '"') {
      const end = sql.indexOf(char, index + 1)
      const value = end === -1 ? rest : sql.slice(index, end + 1)
      push('string', value)
      index += value.length
      continue
    }
    if (/\s/.test(char)) {
      let cursor = index
      while (cursor < sql.length && /\s/.test(sql[cursor])) cursor += 1
      push('space', sql.slice(index, cursor))
      index = cursor
      continue
    }
    if (/[A-Za-z_$@]/.test(char)) {
      let cursor = index
      while (cursor < sql.length && /[A-Za-z0-9_$@.]/.test(sql[cursor])) cursor += 1
      push('word', sql.slice(index, cursor))
      index = cursor
      continue
    }
    push('punct', char)
    index += 1
  }

  return tokens
}

function isKeyword(word: string): boolean {
  return KEYWORD_SET.has(word.toUpperCase())
}

/** 把连续多行/多空格压成一个空格，并去掉注释 */
export function minifySql(sql: string): string {
  const tokens = tokenize(sql).filter((token) => token.type !== 'comment')
  let output = ''
  for (const token of tokens) {
    if (token.type === 'space') {
      if (output && !output.endsWith(' ')) output += ' '
      continue
    }
    output += token.value
  }
  // 括号前后的多余空格顺手收一下
  return output
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, (_match, char: string) => `${char} `)
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+,/g, ',')
    .replace(/\s+;/g, ';')
    .trim()
}

/** 只去掉注释，保留原有换行与缩进 */
export function stripSqlComments(sql: string): string {
  return tokenize(sql)
    .filter((token) => token.type !== 'comment')
    .map((token) => token.value)
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .filter((line, index, all) => !(line.trim() === '' && all[index - 1]?.trim() === ''))
    .join('\n')
    .trim()
}

/** 关键字统一大小写（字符串与注释里的内容不动） */
export function changeSqlKeywordCase(sql: string, mode: 'upper' | 'lower'): string {
  return tokenize(sql)
    .map((token) => {
      if (token.type !== 'word') return token.value
      if (!isKeyword(token.value)) return token.value
      return mode === 'upper' ? token.value.toUpperCase() : token.value.toLowerCase()
    })
    .join('')
}

/**
 * 格式化：大关键字换行、AND/OR 缩进、逗号后换行(expo 可选)。
 * 不追求和某一款商业工具完全一致，目标是「一眼能读」。
 */
export function formatSql(sql: string, options: { keywordCase?: 'upper' | 'lower' | 'keep' } = {}): string {
  const keywordCase = options.keywordCase ?? 'upper'
  const tokens = tokenize(sql).filter((token) => token.type !== 'comment')
  const lines: string[] = []
  let current = ''
  /** 上一个 word token（用来判断括号前该不该留空格） */
  let previousWord = ''

  const flush = (): void => {
    // 行首缩进要保留（AND / OR 靠它缩进），只把中间多余空白压缩掉
    const indent = /^[ \t]+/.test(current) ? '  ' : ''
    const text = current.trim().replace(/[ \t]+/g, ' ')
    if (text) lines.push(indent + text)
    current = ''
  }

  const applyCase = (word: string): string => {
    if (keywordCase === 'keep') return word
    return keywordCase === 'upper' ? word.toUpperCase() : word.toLowerCase()
  }

  /** 在 token 序列里向前看，尝试匹配「LEFT JOIN」这类多词关键字 */
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (token.type === 'space') {
      if (current && !current.endsWith(' ')) current += ' '
      continue
    }

    if (token.type === 'word') {
      // 先尝试多词大关键字（例如 LEFT JOIN / GROUP BY）
      const lookahead = tokens
        .slice(index, index + 6)
        .map((item) => (item.type === 'space' ? ' ' : item.value))
        .join('')
      const matched = MAJOR_SORTED.find((keyword) => {
        const pattern = keyword.split(' ').join(' ')
        return lookahead.toUpperCase().startsWith(pattern) && /^(\s|$|[(,;])/.test(lookahead.slice(pattern.length))
      })
      if (matched) {
        // 只有当前 token 是关键字首词时才按多词处理
        if (token.value.toUpperCase() === matched.split(' ')[0]) {
          flush()
          current = applyCase(matched) + ' '
          // 跳过被这次匹配吃掉的后续 token
          let consumed = matched.length
          let cursor = index
          while (consumed > 0 && cursor < tokens.length) {
            const item = tokens[cursor]
            consumed -= item.type === 'space' ? 1 : item.value.length
            cursor += 1
          }
          index = cursor - 1
          previousWord = matched.split(' ').slice(-1)[0] ?? ''
          continue
        }
      }
      const upper = token.value.toUpperCase()
      if (JOIN_WORDS.includes(upper)) {
        flush()
        current = `  ${applyCase(upper)} `
        previousWord = upper
        continue
      }
      // 只对关键字改大小写，表名 / 字段名 / 参数名保持原样
      current += isKeyword(token.value) ? applyCase(token.value) : token.value
      previousWord = token.value
      continue
    }

    if (token.value === ',') {
      current = current.replace(/\s+$/, '') + ','
      previousWord = ''
      continue
    }
    if (token.value === ';') {
      current = current.replace(/\s+$/, '') + ';'
      previousWord = ''
      flush()
      continue
    }
    if (token.value === '(') {
      // 函数调用（count(...)）紧贴，关键字（IN / VALUES / EXISTS）后面留一个空格
      const keepSpace = previousWord ? isKeyword(previousWord) : false
      current = current.replace(/\s+$/, '') + (keepSpace ? ' (' : '(')
      previousWord = ''
      continue
    }
    if (token.value === ')') {
      current = current.replace(/\s+$/, '') + ')'
      previousWord = ''
      continue
    }
    current += token.value
    previousWord = ''
  }
  flush()

  // 去掉空行、行尾空格
  return lines
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .join('\n')
}

export interface MybatisParam {
  /** 参数名，例如 userName */
  name: string
  /** #{} 还是 ${} */
  kind: 'bind' | 'raw'
  /** #{name,jdbcType=VARCHAR} 里逗号后面的部分 */
  extra: string
  /** 出现次数 */
  count: number
}

/** 解析 SQL 里用到的 MyBatis 参数（按出现顺序去重） */
export function parseMybatisParams(sql: string): MybatisParam[] {
  const result: MybatisParam[] = []
  const pattern = /([#$])\{\s*([^},]+?)\s*(?:,\s*([^}]*))?\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql)) !== null) {
    const kind = match[1] === '#' ? 'bind' : 'raw'
    const name = match[2].trim()
    const extra = (match[3] ?? '').trim()
    const found = result.find((item) => item.name === name && item.kind === kind)
    if (found) found.count += 1
    else result.push({ name, kind, extra, count: 1 })
  }
  return result
}

/** 把用户输入的值转成 SQL 字面量 */
function toSqlLiteral(value: string, kind: 'bind' | 'raw', quoted: boolean): string {
  const text = value.trim()
  if (kind === 'raw') return text
  if (quoted) return `'${text.replace(/'/g, "''")}'`
  if (/^-?\d+(\.\d+)?$/.test(text)) return text
  if (/^null$/i.test(text)) return 'NULL'
  if (/^(true|false)$/i.test(text)) return text.toUpperCase()
  if (/^now\(\)$/i.test(text)) return 'NOW()'
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * 用表单里的值替换 SQL 中的 MyBatis 参数。
 * 传了 quote 标记的参数（通常由界面根据输入框类型决定）会强制加引号。
 */
export function fillMybatisParams(
  sql: string,
  values: Record<string, string>,
  quoteMap: Record<string, boolean> = {}
): string {
  return sql.replace(/([#$])\{\s*([^},]+?)\s*(?:,\s*([^}]*))?\}/g, (match, sigil: string, rawName: string) => {
    const name = rawName.trim()
    const kind = sigil === '#' ? 'bind' : 'raw'
    if (!(name in values)) return match
    return toSqlLiteral(values[name], kind, quoteMap[name] ?? false)
  })
}

/** 输入框里的值看起来该加引号吗（数字、NULL、布尔、函数调用不加） */
export function shouldQuoteValue(value: string): boolean {
  const text = value.trim()
  if (!text) return true
  return !(
    /^-?\d+(\.\d+)?$/.test(text) ||
    /^null$/i.test(text) ||
    /^(true|false)$/i.test(text) ||
    /^[A-Za-z_]+\(.*\)$/.test(text)
  )
}
