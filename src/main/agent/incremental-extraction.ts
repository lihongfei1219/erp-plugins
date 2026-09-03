import fieldConfiguration from '../../../config/erp/unit-initial-approval.fields.json'
import type {
  ExtractionEvidence,
  QualificationRow,
  UnitInitialApprovalExtraction,
  UnitInitialApprovalHeader
} from '../../shared/business'
import {
  normalizeUnitInitialApprovalSubmission,
  type UnitInitialApprovalSubmission
} from './unit-initial-approval-tool'

interface HeaderFieldDefinition {
  key: keyof UnitInitialApprovalHeader
  requiredForExtraction: boolean
}

export interface ExtractionCoverage {
  filled: number
  total: number
  ratio: number
  percent: number
}

const requiredHeaderFields = (
  fieldConfiguration.headerFields as HeaderFieldDefinition[]
)
  .filter((field) => field.requiredForExtraction)
  .map((field) => field.key)

const derivedHeaderFields = new Set<keyof UnitInitialApprovalHeader>([
  'earliestQualificationExpiryDate',
  'qualificationExpiryReminder'
])

function hasValue(value: UnitInitialApprovalHeader[keyof UnitInitialApprovalHeader]): boolean {
  if (Array.isArray(value)) return value.length > 0
  return value !== null && value !== ''
}

function sameValue(
  left: UnitInitialApprovalHeader[keyof UnitInitialApprovalHeader],
  right: UnitInitialApprovalHeader[keyof UnitInitialApprovalHeader]
): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  return left === right
}

function fieldEvidence(
  extraction: UnitInitialApprovalExtraction,
  key: keyof UnitInitialApprovalHeader
): ExtractionEvidence | undefined {
  return extraction.fieldEvidence[`header.${String(key)}`] ?? extraction.fieldEvidence[String(key)]
}

function qualificationKey(row: QualificationRow): string {
  if (row.certificateNo) return `${row.dataType}\u0000${row.certificateNo}`
  return [row.dataType, row.issuingAuthority, row.issueDate, row.expiryDate].join('\u0000')
}

function mergeQualifications(
  currentRows: QualificationRow[],
  incomingRows: QualificationRow[]
): QualificationRow[] {
  const merged = currentRows.map((row) => ({ ...row, sourcePages: [...row.sourcePages] }))
  const rowIndexes = new Map(merged.map((row, index) => [qualificationKey(row), index]))

  for (const incoming of incomingRows) {
    const key = qualificationKey(incoming)
    const existingIndex = rowIndexes.get(key)
    if (existingIndex === undefined) {
      rowIndexes.set(key, merged.length)
      merged.push({ ...incoming, sourcePages: [...incoming.sourcePages] })
      continue
    }

    const existing = merged[existingIndex]
    merged[existingIndex] = {
      dataType: existing.dataType || incoming.dataType,
      certificateNo: existing.certificateNo || incoming.certificateNo,
      issuingAuthority: existing.issuingAuthority || incoming.issuingAuthority,
      issueDate: existing.issueDate || incoming.issueDate,
      expiryDate: existing.expiryDate || incoming.expiryDate,
      expiryControl: existing.expiryControl || incoming.expiryControl,
      materialProvided: existing.materialProvided || incoming.materialProvided,
      sourcePages: [...new Set([...existing.sourcePages, ...incoming.sourcePages])].sort(
        (left, right) => left - right
      )
    }
  }

  return merged
}

export function calculateExtractionCoverage(
  extraction: UnitInitialApprovalExtraction
): ExtractionCoverage {
  const filled = requiredHeaderFields.filter((key) => hasValue(extraction.header[key])).length
  const total = requiredHeaderFields.length
  const ratio = total === 0 ? 1 : filled / total
  return {
    filled,
    total,
    ratio,
    percent: Math.round(ratio * 100)
  }
}

export function mergeExtractions(
  current: UnitInitialApprovalExtraction | null,
  incoming: UnitInitialApprovalExtraction,
  pageCount: number
): UnitInitialApprovalExtraction {
  if (!current) return incoming

  const header: UnitInitialApprovalHeader = {
    ...current.header,
    businessScope: [...current.header.businessScope]
  }
  const evidence: Record<string, ExtractionEvidence> = { ...current.fieldEvidence }
  const conflicts: string[] = []

  for (const key of Object.keys(incoming.header) as Array<keyof UnitInitialApprovalHeader>) {
    if (derivedHeaderFields.has(key)) continue
    const currentValue = header[key]
    const incomingValue = incoming.header[key]

    if (key === 'businessScope') {
      header.businessScope = [
        ...new Set([...header.businessScope, ...incoming.header.businessScope])
      ]
      continue
    }
    if (!hasValue(incomingValue)) continue

    const incomingEvidence = fieldEvidence(incoming, key)
    const currentEvidence = fieldEvidence(current, key)
    if (!hasValue(currentValue)) {
      Object.assign(header, { [key]: incomingValue })
      if (incomingEvidence) evidence[`header.${String(key)}`] = incomingEvidence
      continue
    }
    if (sameValue(currentValue, incomingValue)) {
      if (incomingEvidence && currentEvidence) {
        evidence[`header.${String(key)}`] = {
          sourcePages: [
            ...new Set([...currentEvidence.sourcePages, ...incomingEvidence.sourcePages])
          ].sort((left, right) => left - right),
          confidence: Math.max(currentEvidence.confidence, incomingEvidence.confidence),
          reviewRequired: currentEvidence.reviewRequired || incomingEvidence.reviewRequired
        }
      }
      continue
    }

    conflicts.push(`${String(key)} 在不同页面识别到不同值，已保留置信度较高的结果`)
    if ((incomingEvidence?.confidence ?? 0) > (currentEvidence?.confidence ?? 0)) {
      Object.assign(header, { [key]: incomingValue })
      if (incomingEvidence) evidence[`header.${String(key)}`] = incomingEvidence
    }
  }

  for (const [path, item] of Object.entries(incoming.fieldEvidence)) {
    if (!evidence[path]) evidence[path] = item
  }

  const submission: UnitInitialApprovalSubmission = {
    header,
    qualificationRows: mergeQualifications(
      current.qualificationRows,
      incoming.qualificationRows
    ),
    evidence: Object.entries(evidence).map(([fieldPath, item]) => ({
      fieldPath,
      sourcePages: item.sourcePages,
      confidence: item.confidence,
      reviewRequired: item.reviewRequired
    })),
    reviewRequired: [
      ...current.reviewRequired,
      ...incoming.reviewRequired,
      ...conflicts
    ]
  }

  return normalizeUnitInitialApprovalSubmission(submission, pageCount)
}
