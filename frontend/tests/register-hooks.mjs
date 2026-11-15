import { register } from 'node:module'

// 测试启动入口：注册仅测试环境使用的 TS 解析钩子（@ 别名 + 无扩展名相对导入）。
register('./ts-resolve-hooks.mjs', import.meta.url)
