export function normalizeExcludedPages(value: unknown, pageCount: number): number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error('文档页数无效')
  }
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('排除页码必须是数组')

  const pages = value.map((page) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      throw new Error(`排除页码 ${String(page)} 超出 1-${pageCount} 范围`)
    }
    return page as number
  })
  return [...new Set(pages)].sort((left, right) => left - right)
}
