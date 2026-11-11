// 契約の一括取り込み：テンプレートの列定義・CSV の読み取り・行ごとのチェック（画面から切り離した純粋ロジック）
import type { Account, Contract, Property, TaxCode, Vendor } from './types'
import { parseDateInput } from './format'
import { suggestCounter } from './contractRules'

type Kind = 'text' | 'int' | 'money' | 'date' | 'month' | 'code' | 'flag'

export interface ImportColumn {
  key: keyof Contract
  label: string
  kind: Kind
  required?: boolean
  /** 選択肢の分類（ct_code_values）。kind が code のとき */
  category?: string
  /** 空欄のときに入れる値 */
  fallback?: string
  /** テンプレートの説明 */
  note: string
  example: string
}

/** テンプレートの列（この順で出力し、見出し名で読み取る） */
export const IMPORT_COLUMNS: ImportColumn[] = [
  { key: 'property_code', label: '物件コード', kind: 'int', required: true, note: '物件マスタのコード', example: '11' },
  { key: 'contract_name', label: '契約名', kind: 'text', required: true, note: '', example: 'エレベーター保守料' },
  { key: 'vendor_code', label: '取引先コード', kind: 'int', note: '会計ソフトの取引先コード。マスタに無いコードは取引先名とあわせて新規登録', example: '403300' },
  { key: 'vendor_name', label: '取引先名', kind: 'text', note: '空欄なら取引先マスタの名前', example: '東芝エレベーター株式会社' },
  { key: 'is_active', label: '有効フラグ', kind: 'flag', fallback: '有効', note: '有効／無効（空欄は有効）。無効は月次の計上・仕訳を作らない', example: '有効' },
  { key: 'status', label: '契約状態', kind: 'code', category: 'status', fallback: '契約中', note: '空欄は契約中', example: '契約中' },
  { key: 'txn_type', label: '取引区分', kind: 'code', category: 'txn_type', fallback: '費用', note: '空欄は費用', example: '費用' },
  { key: 'department', label: '契約担当部門', kind: 'code', category: 'department', note: '', example: '管理部' },
  { key: 'person_in_charge', label: '契約担当者', kind: 'text', note: '', example: '' },
  { key: 'trade_note', label: '備考（取引・管理）', kind: 'text', note: '', example: '' },
  { key: 'signed_date', label: '契約締結日', kind: 'date', note: '2026/10/1 などの形', example: '2026/10/1' },
  { key: 'service_start', label: 'サービス開始日', kind: 'date', note: '', example: '2026/11/1' },
  { key: 'service_end', label: 'サービス終了日', kind: 'date', note: '', example: '2027/10/31' },
  { key: 'renewal_type', label: '更新区分', kind: 'code', category: 'renewal_type', fallback: '自動更新', note: '空欄は自動更新', example: '自動更新' },
  { key: 'renewal_term_months', label: '更新期間（か月）', kind: 'int', note: '自動更新の間隔。空欄は契約期間の長さ', example: '12' },
  { key: 'notice_months', label: '解約通知（か月前）', kind: 'int', note: '', example: '3' },
  { key: 'renewal_notice', label: '解約通知の方法・条件', kind: 'text', note: '', example: '書面で通知' },
  { key: 'billing_cycle', label: '請求サイクル', kind: 'code', category: 'billing_cycle', required: true, note: '月次／年次／半年／従量', example: '月次' },
  { key: 'payment_timing', label: '当月分支払月', kind: 'code', category: 'payment_timing', required: true, note: '当月払い／翌月払い／翌々月払い／前月払い／年払い など', example: '翌月払い' },
  { key: 'payment_method', label: '支払方法', kind: 'code', category: 'payment_method', fallback: '月末総振', note: '空欄は月末総振', example: '月末総振' },
  { key: 'annual_payment_month', label: '年払い支払月', kind: 'month', note: '年次・半年のとき必須（1〜12）', example: '' },
  { key: 'annual_start_month', label: '年払対象開始月', kind: 'month', note: '年次・半年のとき必須（1〜12）', example: '' },
  { key: 'annual_period_note', label: '年払い対象期間メモ', kind: 'text', note: '', example: '' },
  { key: 'amount_basis', label: '金額基準', kind: 'code', category: 'amount_basis', required: true, note: '月額／年額／一括／従量／手入力', example: '月額' },
  { key: 'amount_excl', label: '税抜契約金額', kind: 'money', note: '従量・手入力以外は必須', example: '31000' },
  { key: 'tax_amount', label: '消費税', kind: 'money', note: '空欄は税区分の税率で自動計算（切捨て）', example: '' },
  { key: 'tax_code', label: '税区分', kind: 'code', category: '__tax', fallback: '課税10%', note: '空欄は課税10%', example: '課税10%' },
  { key: 'invoice_type', label: 'インボイス区分', kind: 'code', category: 'invoice_type', fallback: '適格', note: '空欄は適格', example: '適格' },
  { key: 'pl_account_code', label: '損益科目コード', kind: 'int', required: true, note: '例：5310 管理費(BM)Ⅰ', example: '5310' },
  { key: 'pl_sub_code', label: '損益補助科目', kind: 'text', note: '', example: '' },
  { key: 'counter_account_code', label: '相手科目コード', kind: 'int', note: '空欄は支払月から自動（翌月払い→3150 未払費用 など）', example: '' },
  { key: 'recognition_method', label: '計上方式', kind: 'code', category: 'recognition_method', fallback: '月割', note: '空欄は月割', example: '' },
  { key: 'journal_date_rule', label: '仕訳日ルール', kind: 'code', category: 'journal_date_rule', fallback: '月末', note: '空欄は月末', example: '' },
  { key: 'ringi_no', label: '稟議書NO', kind: 'text', note: '', example: '' },
  { key: 'contract_url', label: '契約書URL', kind: 'text', note: '', example: '' },
  { key: 'note', label: '備考（請求・金額）', kind: 'text', note: '', example: '' },
  { key: 'note2', label: '備考（管理・証憑）', kind: 'text', note: '', example: '' },
]

/**
 * テンプレートの記入例の行の目印。物件コードの欄に書き、取り込み時はこの行を読み飛ばす。
 * （以前は契約名の欄に書いていたが「契約名が取り込まれない」と読めて紛らわしいため移した。古いテンプレートの行も読み飛ばす）
 */
export const EXAMPLE_MARK = '記入例'
const OLD_EXAMPLE_MARK = '（記入例・この行は取り込まれません）'

export function templateRows(): string[][] {
  const head = IMPORT_COLUMNS.map((c) => (c.required ? `${c.label}*` : c.label))
  const example = IMPORT_COLUMNS.map((c) => (c.key === 'property_code' ? EXAMPLE_MARK : c.example))
  return [head, example]
}

/** CSV 文字列を行×列に分解（ダブルクォート・改行入りセル対応） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++ } else q = false
      } else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

const normLabel = (s: string) => s.normalize('NFKC').replace(/[\s*＊※]/g, '').replace(/[()]/g, (m) => (m === '(' ? '（' : '）'))

export interface ImportMasters {
  properties: Property[]
  accounts: Account[]
  vendors: Vendor[]
  taxCodes: TaxCode[]
  options: (category: string) => string[]
  /** 総務経理部か（経理のみの物件に登録できる） */
  isAccounting: boolean
}

export interface ImportRow {
  line: number
  values: Partial<Contract>
  errors: string[]
  warnings: string[]
  /** マスタに無く、新しく登録する取引先 */
  newVendor: { code: number; name: string } | null
}

export interface ImportResult {
  rows: ImportRow[]
  /** 見出しで見つからなかった必須列 */
  missingColumns: string[]
  /** テンプレートに無い見出し（読み飛ばす） */
  unknownColumns: string[]
}

export function readImport(table: string[][], m: ImportMasters): ImportResult {
  if (!table.length) return { rows: [], missingColumns: IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.label), unknownColumns: [] }
  const head = table[0].map(normLabel)
  const byLabel = new Map(IMPORT_COLUMNS.map((c) => [normLabel(c.label), c]))
  const index = new Map<keyof Contract, number>()
  const unknownColumns: string[] = []
  head.forEach((h, i) => {
    const c = byLabel.get(h)
    if (c) index.set(c.key, i)
    else if (h) unknownColumns.push(table[0][i])
  })
  const missingColumns = IMPORT_COLUMNS.filter((c) => c.required && !index.has(c.key)).map((c) => c.label)

  const prop = new Map(m.properties.map((p) => [p.code, p]))
  const acc = new Map(m.accounts.map((a) => [a.code, a]))
  const vend = new Map(m.vendors.map((v) => [v.code, v]))
  const tax = new Map(m.taxCodes.map((t) => [t.name, t]))
  const newVendorNames = new Map<number, string>()

  const rows: ImportRow[] = []
  table.slice(1).forEach((cells, i) => {
    const line = i + 2
    // 文章の欄は入力どおり、数値・日付・選択肢の欄は全角を半角にそろえて読む
    const raw = (k: keyof Contract, normalize = true) => {
      const idx = index.get(k)
      const s = idx === undefined ? '' : (cells[idx] ?? '').trim()
      return normalize ? s.normalize('NFKC') : s
    }
    if (raw('property_code').startsWith(EXAMPLE_MARK) || raw('contract_name', false).includes(OLD_EXAMPLE_MARK)) return

    const v: Partial<Contract> = {}
    const errors: string[] = []
    const warnings: string[] = []
    const set = <K extends keyof Contract>(k: K, val: Contract[K]) => { v[k] = val }

    for (const c of IMPORT_COLUMNS) {
      let text = raw(c.key, c.kind !== 'text')
      if (!text && c.fallback) text = c.fallback
      if (!text) {
        if (c.required) errors.push(`${c.label}が空欄です`)
        continue
      }
      switch (c.kind) {
        case 'text':
          set(c.key, text as never)
          break
        case 'int':
        case 'money': {
          const n = Number(text.replace(/[,，円¥\\]/g, ''))
          if (!Number.isFinite(n) || (c.kind === 'int' && !Number.isInteger(n))) errors.push(`${c.label}「${text}」が数値ではありません`)
          else set(c.key, n as never)
          break
        }
        case 'month': {
          const n = Number(text.replace(/月$/, ''))
          if (!Number.isInteger(n) || n < 1 || n > 12) errors.push(`${c.label}「${text}」は1〜12で入力してください`)
          else set(c.key, n as never)
          break
        }
        case 'date': {
          const d = parseDateInput(text)
          if (d === undefined) errors.push(`${c.label}「${text}」が日付として読めません`)
          else set(c.key, d as never)
          break
        }
        case 'flag':
          if (text === '有効' || text === '無効') set(c.key, (text === '有効') as never)
          else errors.push(`${c.label}「${text}」は「有効」か「無効」で入力してください`)
          break
        case 'code': {
          const allowed = c.category === '__tax' ? [...tax.keys()] : m.options(c.category!)
          // 全角・半角の違いは同じとみなし、マスタの表記で登録する
          const hit = allowed.find((a) => a.normalize('NFKC') === text)
          if (!hit) errors.push(`${c.label}「${text}」はマスタにありません（${allowed.join('・')}）`)
          else set(c.key, hit as never)
          break
        }
      }
    }

    // 物件
    const p = v.property_code != null ? prop.get(v.property_code) : undefined
    if (v.property_code != null && !p) errors.push(`物件コード ${v.property_code} が物件マスタにありません`)
    if (p?.accounting_only && !m.isAccounting) errors.push(`物件「${p.name}」は総務経理部のみ登録できます`)
    if (p && !p.is_active) warnings.push(`物件「${p.name}」は使用中ではありません`)
    v.accounting_only = Boolean(p?.accounting_only)

    // 取引先
    let newVendor: ImportRow['newVendor'] = null
    if (v.vendor_code != null) {
      const known = vend.get(v.vendor_code)
      if (known) {
        if (!v.vendor_name) v.vendor_name = known.name
        else if (v.vendor_name !== known.name) warnings.push(`取引先名が取引先マスタ（${known.name}）と違います`)
      } else if (!v.vendor_name) {
        errors.push(`取引先コード ${v.vendor_code} は取引先マスタに無いため、取引先名も入力してください`)
      } else {
        const prev = newVendorNames.get(v.vendor_code)
        if (prev && prev !== v.vendor_name) errors.push(`取引先コード ${v.vendor_code} の取引先名が他の行（${prev}）と違います`)
        newVendorNames.set(v.vendor_code, v.vendor_name)
        newVendor = { code: v.vendor_code, name: v.vendor_name }
        warnings.push(`取引先 ${v.vendor_code} ${v.vendor_name} を取引先マスタに新しく登録します`)
      }
    }

    // 科目
    if (v.pl_account_code != null) {
      const a = acc.get(v.pl_account_code)
      if (!a) errors.push(`損益科目コード ${v.pl_account_code} が勘定科目にありません`)
      else if (a.bs_pl === 'BS') warnings.push(`損益科目に BS の科目（${a.code} ${a.name}）が指定されています`)
    }
    if (v.counter_account_code == null) {
      const s = suggestCounter(v)
      if (s != null) v.counter_account_code = s
      else errors.push('相手科目コードを入力してください（支払月から自動で決められません）')
    } else {
      const a = acc.get(v.counter_account_code)
      if (!a) errors.push(`相手科目コード ${v.counter_account_code} が勘定科目にありません`)
      else if (!a.is_accrual) warnings.push(`相手科目（${a.code} ${a.name}）は経過勘定ではありません`)
    }

    // 金額・年払い
    const variable = v.amount_basis === '従量' || v.amount_basis === '手入力'
    if (!variable && v.amount_excl == null && !raw('amount_excl')) errors.push('税抜契約金額が空欄です（従量・手入力以外は必須）')
    if (v.amount_excl != null && v.tax_amount == null) {
      const rate = Number(tax.get(v.tax_code ?? '')?.rate ?? 0)
      v.tax_amount = Math.floor(Number(v.amount_excl) * rate)
    }
    const isCycle = v.billing_cycle === '年次' || v.billing_cycle === '半年'
    if (isCycle) {
      if (v.annual_payment_month == null) errors.push('年次・半年の契約は年払い支払月が必須です')
      if (v.annual_start_month == null) errors.push('年次・半年の契約は年払対象開始月が必須です')
      if (v.amount_basis !== '年額' && v.amount_basis !== '一括') errors.push('年次・半年の契約は金額基準を「年額」か「一括」にしてください')
    }
    if (v.billing_cycle === '月次' && (v.amount_basis === '年額' || v.amount_basis === '一括')) errors.push('月次の契約で金額基準が年額・一括になっています')

    // 期間・状態
    if (v.service_start && v.service_end && v.service_end < v.service_start) errors.push('サービス終了日が開始日より前です')
    if ((v.status === '解約予定' || v.status === '解約済') && !v.cancel_date) errors.push('解約予定・解約済の契約は取り込めません（契約編集で解約日を入れてください）')

    v.version = 1
    rows.push({ line, values: v, errors, warnings, newVendor })
  })
  return { rows, missingColumns, unknownColumns }
}
