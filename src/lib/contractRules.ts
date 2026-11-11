import type { Contract } from './types'

/** 相手科目（経過勘定）の自動提案。Excel「相手科目コード」の自動判定と同じルール */
export function suggestCounter(c: Partial<Contract>): number | null {
  if (c.txn_type !== '費用') return null
  if (c.billing_cycle === '年次' || c.billing_cycle === '半年') return (c.annual_period_note ?? '').includes('前年') ? 3150 : 1550
  switch (c.payment_timing) {
    case '前月払い':
    case '年払い':
      return 1550
    case '当月払い':
      return 3140
    case '翌月払い':
    case '翌月末':
    case '翌々月払い':
      return 3150
    default:
      return null
  }
}

/** 支払仕訳を自動で作れる支払区分（DB の ct_payment_lag と同じ） */
export const PAYMENT_TIMINGS = ['前月払い', '当月払い', '翌月払い', '翌月末', '翌々月払い']
