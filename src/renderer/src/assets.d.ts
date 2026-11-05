/**
 * 静态资源类型声明。
 * 这个文件里不要出现顶层 import / export，否则会被当成模块，
 * 下面的 `declare module '*.svg'` 就变成模块增强而失效了。
 */
declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}
