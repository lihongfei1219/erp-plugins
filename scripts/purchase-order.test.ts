import assert from 'node:assert/strict'
import test from 'node:test'
import type { PurchaseOrderSubmission } from '../src/main/businesses/purchase-order-tool'
import {
  calculatePurchaseOrderCoverage,
  mergePurchaseOrderExtractions,
  normalizePurchaseOrderSubmission
} from '../src/main/businesses/purchase-order-tool'

function submission(
  quantities: number[],
  pageNumber = 1
): PurchaseOrderSubmission {
  const batches = ['251103', '251202', '251203', '251203']
  const productionDates = ['2025-11-08', '2025-12-05', '2025-12-05', '2025-12-05']
  const expiryDates = ['2027-10-31', '2027-11-30', '2027-11-30', '2027-11-30']
  return {
    header: {
      supplierName: '江西康强医药有限公司',
      sourceOrderNumber: 'SCKGAK000007111',
      invoiceDate: '2026-08-11',
      departureDate: '2026-08-11',
      customerName: '吉林柏锦医药有限公司',
      receivingAddress: null,
      carrierName: '江西仁济医药有限公司',
      transportMethod: null,
      coldChain: null,
      transportTimeLimit: null,
      receiptRemark: null,
      remark: null,
      paymentMethod: null,
      groupName: null
    },
    items: quantities.map((quantity, index) => ({
      productName: '健胃消食片',
      specification: '0.8g*8片*4板/盒',
      dosageForm: '片剂',
      manufacturer: '修正药业集团股份有限公司',
      origin: '通化市修正路36号',
      approvalNumber: '国药准字Z20063187',
      marketingAuthorizationHolder: '修正药业集团股份有限公司',
      unit: '盒',
      packageQuantity: 300,
      batchNumber: batches[index] ?? `batch-${index}`,
      quantity,
      taxIncludedUnitPrice: 4.221,
      taxIncludedAmount: quantity * 4.221,
      productionDate: productionDates[index] ?? '2025-12-05',
      expiryDate: expiryDates[index] ?? '2027-11-30',
      qualityStatus: '合格',
      sourcePages: [pageNumber]
    })),
    evidence: [],
    reviewRequired: []
  }
}

test('preserves every printed purchase row even when products and prices are identical', () => {
  const extraction = normalizePurchaseOrderSubmission(
    submission([17100, 120, 180, 12600]),
    1
  )

  assert.equal(extraction.header.supplierName, '江西康强医药有限公司')
  assert.equal(extraction.header.customerName, '吉林柏锦医药有限公司')
  assert.equal(extraction.items.length, 4)
  assert.deepEqual(extraction.items.map((item) => item.quantity), [17100, 120, 180, 12600])
  assert.deepEqual(extraction.items.map((item) => item.taxIncludedAmount), [
    72179.1,
    506.52,
    759.78,
    53184.6
  ])
  assert.deepEqual(extraction.items.map((item) => item.batchNumber), [
    '251103',
    '251202',
    '251203',
    '251203'
  ])
  assert.ok(extraction.items.every((item) => item.taxIncludedUnitPrice === 4.221))
  assert.equal(
    extraction.items.reduce((total, item) => total + (item.quantity ?? 0), 0),
    30000
  )
  assert.equal(extraction.readyForAutofill, true)
  assert.ok(extraction.reviewRequired.some((item) => item.includes('付款方式')))
  assert.equal(calculatePurchaseOrderCoverage(extraction), 86)
})

test('appends identical products across OCR pages without aggregation', () => {
  const first = normalizePurchaseOrderSubmission(submission([100], 1), 2)
  const second = normalizePurchaseOrderSubmission(submission([200], 2), 2)
  const merged = mergePurchaseOrderExtractions(first, second)

  assert.equal(merged.items.length, 2)
  assert.deepEqual(merged.items.map((item) => item.quantity), [100, 200])
  assert.deepEqual(merged.items.map((item) => item.taxIncludedAmount), [422.1, 844.2])
  assert.deepEqual(merged.items.map((item) => item.sourcePages), [[1], [2]])
})
