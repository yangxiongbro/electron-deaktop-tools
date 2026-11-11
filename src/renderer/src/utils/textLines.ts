/** 多行文本处理：去空行、去重、排序、大小写等纯函数 */

export type SortMode = 'none' | 'asc' | 'desc' | 'length-asc' | 'length-desc'
export type CaseMode = 'keep' | 'upper' | 'lower' | 'capitalize'

export interface TextOptions {
  removeEmpty: boolean
  removeDuplicate: boolean
  trimLines: boolean
  reverse: boolean
  sort: SortMode
  caseMode: CaseMode
}

export const DEFAULT_TEXT_OPTIONS: TextOptions = {
  removeEmpty: true,
  removeDuplicate: false,
  trimLines: false,
  reverse: false,
  sort: 'none',
  caseMode: 'keep'
}

function applyCase(line: string, mode: CaseMode): string {
  switch (mode) {
    case 'upper':
      return line.toUpperCase()
    case 'lower':
      return line.toLowerCase()
    case 'capitalize':
      return line.replace(/\b[a-z]/g, (char) => char.toUpperCase())
    default:
      return line
  }
}

/** 按固定顺序依次处理：去首尾空白 → 去空行 → 去重 → 排序 → 反转 → 大小写 */
export function processText(input: string, options: TextOptions): string {
  let lines = input.split('\n')

  if (options.trimLines) lines = lines.map((line) => line.replace(/^\s+|\s+$/g, ''))
  if (options.removeEmpty) lines = lines.filter((line) => line.trim() !== '')
  if (options.removeDuplicate) {
    const seen = new Set<string>()
    lines = lines.filter((line) => {
      const key = line.trim()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  if (options.sort !== 'none') {
    lines = [...lines].sort((left, right) => {
      switch (options.sort) {
        case 'asc':
          return left.localeCompare(right, 'zh-Hans-CN')
        case 'desc':
          return right.localeCompare(left, 'zh-Hans-CN')
        case 'length-asc':
          return left.length - right.length || left.localeCompare(right, 'zh-Hans-CN')
        case 'length-desc':
          return right.length - left.length || left.localeCompare(right, 'zh-Hans-CN')
        default:
          return 0
      }
    })
  }

  if (options.reverse) lines = [...lines].reverse()
  if (options.caseMode !== 'keep') lines = lines.map((line) => applyCase(line, options.caseMode))

  return lines.join('\n')
}

export interface TextStats {
  lines: number
  nonEmptyLines: number
  characters: number
  words: number
}

export function textStats(text: string): TextStats {
  if (!text) return { lines: 0, nonEmptyLines: 0, characters: 0, words: 0 }
  const lines = text.split('\n')
  return {
    lines: lines.length,
    nonEmptyLines: lines.filter((line) => line.trim() !== '').length,
    characters: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0
  }
}
