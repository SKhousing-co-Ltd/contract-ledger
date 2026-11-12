import type { Contract } from './types'

/**
 * 相手科目（経過勘定）の自動提案。年払い・半年払いは前払い（1550 前払費用）を既定にし、
 * 後払いは画面の「前払い／後払い」で 3150 未払費用を選ぶ（以前のメモ欄の「前年」による判定はやめた）
 */
export function suggestCounter(c: Partial<Contract>): number | null {
  if (c.txn_type !== '費用') return null
  if (c.billing_cycle === '年次' || c.billing_cycle === '半年') return 1550
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

/** 相手科目ごとの補助科目の既定値（設定 counter_sub_defaults「3150:9,1550:1」） */
export function counterSubDefault(account: number | null | undefined, setting: string): string | null {
  if (account == null) return null
  for (const pair of (setting || '3150:9,1550:1').split(',')) {
    const [a, b] = pair.split(':').map((x) => x.trim())
    if (Number(a) === account && b) return b
  }
  return null
}

/**
 * 相手科目が変わったときの補助科目。手で入れた値は残し、空欄か「前の科目の既定値」のときだけ新しい科目の既定値にする
 */
export function nextCounterSub(prevAccount: number | null | undefined, nextAccount: number | null | undefined,
  currentSub: string | null | undefined, setting: string): string | null {
  const cur = currentSub || null
  if (prevAccount === nextAccount) return cur
  if (cur === null || cur === counterSubDefault(prevAccount, setting)) return counterSubDefault(nextAccount, setting)
  return cur
}

/** 源泉徴収税額（報酬）：100万円以下は 10.21%、超える部分は 20.42%（1円未満切捨て） */
export function withholdingTax(amountExcl: number): number {
  const a = Math.max(0, Math.floor(amountExcl))
  return a <= 1_000_000 ? Math.floor(a * 0.1021) : 102_100 + Math.floor((a - 1_000_000) * 0.2042)
}

/** 支払仕訳を自動で作れる支払区分（DB の ct_payment_lag と同じ） */
export const PAYMENT_TIMINGS = ['前月払い', '当月払い', '翌月払い', '翌月末', '翌々月払い']
