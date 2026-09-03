import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  QualificationRow,
  UnitInitialApprovalExtraction,
  UnitInitialApprovalHeader
} from '../src/shared/business'
import {
  calculateExtractionCoverage,
  mergeExtractions
} from '../src/main/agent/incremental-extraction'

function emptyHeader(): UnitInitialApprovalHeader {
  return {
    referenceYaoshibang: null,
    referenceYaobang: null,
    unitCode: null,
    exists: null,
    unitName: null,
    buyerName: null,
    businessDivision: null,
    buyerIdCardNo: null,
    companyBankName: null,
    unitShortName: null,
    businessLicenseNo: null,
    legalRepresentative: null,
    companyTaxNo: null,
    registeredAddress: null,
    companyInvoiceType: null,
    selfPickupName: null,
    warehouseAddress: null,
    companyAccountName: null,
    selfPickupIdCardNo: null,
    unitPhone: null,
    companyBankAccount: null,
    siteInspectionStatus: null,
    qualityResponsiblePerson: null,
    unitType: null,
    invoiceContactPhone: null,
    enterpriseResponsiblePerson: null,
    receivingPerson: null,
    receivingPhone: null,
    receivingAddress: null,
    earliestQualificationExpiryDate: null,
    qualificationExpiryReminder: null,
    businessScope: []
  }
}

function qualification(overrides: Partial<QualificationRow> = {}): QualificationRow {
  return {
    dataType: '营业执照',
    certificateNo: '91320000TEST000001',
    issuingAuthority: '市场监督管理局',
    issueDate: '2025-01-01',
    expiryDate: null,
    expiryControl: false,
    materialProvided: true,
    sourcePages: [1],
    ...overrides
  }
}

function extraction(
  headerOverrides: Partial<UnitInitialApprovalHeader>,
  options: {
    confidence?: number
    qualificationRows?: QualificationRow[]
  } = {}
): UnitInitialApprovalExtraction {
  const header = { ...emptyHeader(), ...headerOverrides }
  const fieldEvidence = Object.fromEntries(
    Object.entries(headerOverrides).map(([key]) => [
      `header.${key}`,
      {
        sourcePages: [1],
        confidence: options.confidence ?? 0.8,
        reviewRequired: false
      }
    ])
  )
  return {
    documentType: 'unit-initial-approval',
    header,
    qualificationRows: options.qualificationRows ?? [],
    fieldEvidence,
    recognizedFieldCount: Object.values(headerOverrides).filter(Boolean).length,
    missingRecommendedFields: [],
    reviewRequired: [],
    readyForAutofill: false
  }
}

const twelveRequiredFields: Partial<UnitInitialApprovalHeader> = {
  unitName: '测试企业',
  companyBankName: '测试银行',
  legalRepresentative: '张三',
  companyTaxNo: '91320000TEST000001',
  businessLicenseNo: '91320000TEST000001',
  registeredAddress: '测试地址',
  companyAccountName: '测试企业',
  warehouseAddress: '测试仓库',
  companyBankAccount: '6222000000000000',
  unitPhone: '025-12345678',
  qualityResponsiblePerson: '李四',
  unitType: '批发企业'
}

test('calculates coverage from the 14 required header fields', () => {
  const result = calculateExtractionCoverage(extraction(twelveRequiredFields))
  assert.equal(result.total, 14)
  assert.equal(result.filled, 12)
  assert.equal(result.percent, 86)
})

test('merges page fields and keeps the higher-confidence conflicting value', () => {
  const current = extraction(
    { unitName: '旧名称', businessLicenseNo: '91320000TEST000001' },
    { confidence: 0.6, qualificationRows: [qualification()] }
  )
  const incoming = extraction(
    { unitName: '新名称', registeredAddress: '新地址' },
    { confidence: 0.9, qualificationRows: [qualification({ sourcePages: [2] })] }
  )
  const merged = mergeExtractions(current, incoming, 2)

  assert.equal(merged.header.unitName, '新名称')
  assert.equal(merged.header.registeredAddress, '新地址')
  assert.equal(merged.qualificationRows.length, 1)
  assert.deepEqual(merged.qualificationRows[0].sourcePages, [1, 2])
  assert.ok(merged.reviewRequired.some((item) => item.includes('unitName')))
})
