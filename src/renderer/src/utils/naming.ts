/**
 * 命名风格转换：先按常见分隔符与大写边界切词，再按目标风格拼接。
 */

export type NamingStyle =
  | 'camel'
  | 'pascal'
  | 'snake'
  | 'constant'
  | 'kebab'
  | 'dot'
  | 'space'
  | 'title'

/** 把任意命名切分成单词数组，保留原始大小写信息 */
export function splitWords(input: string): string[] {
  const normalized = input
    .trim()
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\s/\\]+/g, ' ')
  return normalized
    .split(' ')
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
}

function capitalize(word: string): string {
  if (!word) return ''
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

export function toWords(input: string): string[] {
  return splitWords(input).map((word) => word.toLowerCase())
}

export function convertNaming(input: string, style: NamingStyle): string {
  const words = splitWords(input)
  if (words.length === 0) return ''
  const lower = words.map((word) => word.toLowerCase())

  switch (style) {
    case 'camel':
      return lower.map((word, index) => (index === 0 ? word : capitalize(word))).join('')
    case 'pascal':
      return lower.map((word) => capitalize(word)).join('')
    case 'snake':
      return lower.join('_')
    case 'constant':
      return lower.join('_').toUpperCase()
    case 'kebab':
      return lower.join('-')
    case 'dot':
      return lower.join('.')
    case 'space':
      return lower.join(' ')
    case 'title':
      return lower.map((word) => capitalize(word)).join(' ')
    default:
      return input
  }
}

export interface NamingMode {
  id: string
  label: string
  example: string
  from: string
  to: string
  style: NamingStyle
}

export const NAMING_MODES: NamingMode[] = [
  {
    id: 'snake-camel',
    label: '下划线 → 小驼峰',
    example: 'user_name → userName',
    from: '下划线命名（snake_case）',
    to: '小驼峰命名（camelCase）',
    style: 'camel'
  },
  {
    id: 'camel-snake',
    label: '驼峰 → 下划线小写',
    example: 'userName → user_name',
    from: '驼峰命名（camelCase）',
    to: '下划线小写（snake_case）',
    style: 'snake'
  },
  {
    id: 'camel-constant',
    label: '驼峰 → 下划线大写',
    example: 'userName → USER_NAME',
    from: '驼峰命名（camelCase）',
    to: '下划线大写常量（CONSTANT_CASE）',
    style: 'constant'
  },
  {
    id: 'snake-pascal',
    label: '下划线 → 大驼峰',
    example: 'user_name → UserName',
    from: '下划线命名（snake_case）',
    to: '大驼峰命名（PascalCase）',
    style: 'pascal'
  },
  {
    id: 'camel-kebab',
    label: '驼峰 → 中划线',
    example: 'userName → user-name',
    from: '驼峰命名（camelCase）',
    to: '中划线命名（kebab-case）',
    style: 'kebab'
  },
  {
    id: 'kebab-camel',
    label: '中划线 → 小驼峰',
    example: 'user-name → userName',
    from: '中划线命名（kebab-case）',
    to: '小驼峰命名（camelCase）',
    style: 'camel'
  },
  {
    id: 'camel-dot',
    label: '驼峰 → 点号分隔',
    example: 'userName → user.name',
    from: '驼峰命名（camelCase）',
    to: '点号分隔（dot.case）',
    style: 'dot'
  },
  {
    id: 'camel-space',
    label: '驼峰 → 空格分隔',
    example: 'userName → user name',
    from: '驼峰命名（camelCase）',
    to: '空格分隔',
    style: 'space'
  },
  {
    id: 'camel-title',
    label: '驼峰 → 首字母大写',
    example: 'userName → User Name',
    from: '驼峰命名（camelCase）',
    to: '单词首字母大写（Title Case）',
    style: 'title'
  }
]
