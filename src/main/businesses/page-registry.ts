import type { BusinessId, ErpPageContext } from '../../shared/business'

export interface ErpPageDescriptor {
  ename: string | null
  cname: string | null
  mode: string | null
  title: string
  frameUrl: string
  elementIds: string[]
  visible: boolean
}

function normalized(value: string | null): string {
  return value?.trim().toLowerCase() ?? ''
}

export function resolveBusinessId(descriptor: ErpPageDescriptor): BusinessId | null {
  const ename = normalized(descriptor.ename)
  const cname = normalized(descriptor.cname)
  const title = normalized(descriptor.title)
  const fields = new Set(descriptor.elementIds.map((value) => value.toUpperCase()))

  if (
    ename === 'cgdd' ||
    (cname === '采购订单' && fields.has('DWMC') && fields.has('QYRQ') && fields.has('FKFS'))
  ) return 'purchase-order'
  if (ename === 'spshdj' || cname.includes('商品收货登记')) return 'goods-receipt'
  if (
    cname.includes('单位首营') ||
    (title.includes('单位首营审批') && fields.has('DWMC') && fields.has('YYZZH'))
  ) {
    return 'unit-initial-approval'
  }
  return null
}

export function toPageContext(descriptor: ErpPageDescriptor): ErpPageContext {
  const businessId = resolveBusinessId(descriptor)
  let typeFromUrl = ''
  try {
    typeFromUrl = new URL(descriptor.frameUrl).searchParams.get('Type') ?? ''
  } catch {
    // A malformed frame URL is unsupported and handled below.
  }
  const mode = normalized(descriptor.mode)
  const isNew = mode === 'add' || mode === '新建' || typeFromUrl.toLowerCase() === 'add'
  return {
    businessId,
    ename: descriptor.ename,
    cname: descriptor.cname,
    mode: descriptor.mode,
    title: descriptor.title,
    frameUrl: descriptor.frameUrl,
    supported: businessId !== null,
    isNew
  }
}
