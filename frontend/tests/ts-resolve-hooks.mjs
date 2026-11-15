/**
 * 仅测试环境使用的 ESM 解析钩子：
 * 1. 把 `@/` 别名映射到 src/；
 * 2. 给无扩展名的相对导入与 file:// 导入补上 .ts。
 * 生产构建仍由 Vite / tsc 处理，源码导入风格保持不变。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url))

function resolveWithExtension(specifier, context, nextResolve) {
  if (!/\.[a-zA-Z0-9]+$/.test(specifier)) {
    const baseUrl = new URL(specifier, context.parentURL)
    const basePath = fileURLToPath(baseUrl)
    const candidates = [`${basePath}.ts`, `${basePath}/index.ts`]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context)
      }
    }
  }
  return nextResolve(specifier, context)
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return resolveWithExtension(pathToFileURL(`${SRC_ROOT}${specifier.slice(2)}`).href, context, nextResolve)
  }
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:')) {
    return resolveWithExtension(specifier, context, nextResolve)
  }
  return nextResolve(specifier, context)
}
