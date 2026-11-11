export type Department = '総務経理部' | '管理部'
export type Role = 'admin' | 'editor' | 'viewer'

export interface Profile {
  user_id: string
  display_name: string
  department: Department
  role: Role
}

export interface Property {
  code: number
  name: string
  kind: string
  /** 住宅（原価の課税仕入を共通対応 11 にする）。集計用の区分とは別 */
  is_residential: boolean
  accounting_only: boolean
  is_active: boolean
  sort: number
}

export interface Account {
  code: number
  name: string
  short_name: string | null
  bs_pl: string | null
  normal_side: '借方' | '貸方'
  is_accrual: boolean
  is_active: boolean
}

export interface Vendor {
  code: number
  name: string
  note: string | null
}

export interface TaxCode {
  name: string
  rate: number
  kokuyo_tax_code: string | null
  kokuyo_rate_kbn: string | null
  sort: number
}

export interface CodeValue {
  category: string
  value: string
  sort: number
}

export interface Setting {
  key: string
  value: string | null
  label: string | null
}

export interface Contract {
  id: number
  contract_no: number
  version: number
  is_active: boolean
  status: string
  txn_type: string
  property_code: number
  vendor_code: number | null
  vendor_name: string | null
  contract_name: string
  department: string | null
  person_in_charge: string | null
  trade_note: string | null
  signed_date: string | null
  service_start: string | null
  service_end: string | null
  cancel_date: string | null
  renewal_type: string | null
  renewal_notice: string | null
  notice_months: number | null
  renewal_term_months: number | null
  first_billing_date: string | null
  billing_cycle: string | null
  payment_timing: string | null
  payment_method: string | null
  withholding_amount: number | null
  annual_payment_month: number | null
  annual_period_note: string | null
  amount_basis: string | null
  amount_excl: number | null
  tax_amount: number | null
  amount_incl?: number | null
  note: string | null
  tax_code: string | null
  invoice_type: string | null
  recognition_method: string | null
  rounding: string | null
  journal_date_rule: string | null
  pl_account_code: number | null
  pl_sub_code: string | null
  counter_account_code: number | null
  counter_sub_code: string | null
  annual_start_month: number | null
  accounting_only: boolean
  ringi_no: string | null
  contract_url: string | null
  note2: string | null
  created_at?: string
  updated_at?: string
}

export interface ContractView extends Contract {
  property_name: string | null
  property_kind: string | null
  pl_account_name: string | null
  counter_account_name: string | null
  monthly_excl: number | null
  annual_excl: number | null
  allocation_count: number
  calc_target: '対象' | '対象外' | '要設定'
  issues: string | null
}

export interface Allocation {
  id?: number
  contract_id?: number
  property_code: number
  label: string | null
  amount_excl: number
  sort: number
}

export interface ContractItem {
  id?: number
  contract_id?: number
  item_name: string
  amount_excl: number | null
  note: string | null
  sort: number
  /** 損益科目。入っている行があれば計上をこの行の金額の割合で科目別に分ける（科目明細） */
  pl_account_code?: number | null
  pl_sub_code?: string | null
}

export interface HistoryRow {
  id: number
  contract_id: number
  contract_no: number
  version: number
  action: 'INSERT' | 'UPDATE' | 'DELETE'
  changed_at: string
  changed_by_name: string | null
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
}

export interface CalcRow {
  contract_id: number
  contract_no: number
  version: number
  property_code: number
  property_name: string
  vendor_code: number | null
  vendor_name: string | null
  contract_name: string
  txn_type: string
  billing_cycle: string | null
  payment_timing: string | null
  amount_basis: string | null
  annual_payment_month: number | null
  annual_start_month: number | null
  tax_code: string | null
  pl_account_code: number | null
  counter_account_code: number | null
  judgement: '計上' | '実績入力済' | '実績入力待ち' | '要設定' | '対象外'
  actual_excl: number | null
  amount_excl: number | null
  tax_amount: number | null
  amount_incl: number | null
  description: string | null
  issues: string | null
}

export interface JournalEntry {
  id: number
  period: string
  entry_date: string
  entry_type: 'accrual' | 'withholding' | 'payment' | 'adjust'
  source: 'auto' | 'manual'
  contract_id: number | null
  contract_no: number | null
  dr_account: number
  dr_sub_code: string | null
  dr_dept: number | null
  dr_vendor: number | null
  dr_amount: number
  dr_tax_amount: number
  dr_tax_code: string | null
  cr_account: number
  cr_sub_code: string | null
  cr_dept: number | null
  cr_vendor: number | null
  cr_amount: number
  cr_tax_amount: number
  cr_tax_code: string | null
  description: string | null
  exported_at: string | null
  export_batch: string | null
}

export interface BalanceRow {
  period: string
  account_code: number
  account_name: string
  contract_no: number | null
  opening: number
  debit: number
  credit: number
  closing: number
}

export interface OpeningBalance {
  id: number
  period: string
  contract_no: number | null
  account_code: number
  amount: number
  note: string | null
}

export const ENTRY_TYPE_LABEL: Record<JournalEntry['entry_type'], string> = {
  accrual: '計上',
  withholding: '源泉税',
  payment: '支払・入金',
  adjust: '調整',
}

/** 履歴の差分表示に使う項目名 */
export const FIELD_LABELS: Record<string, string> = {
  contract_no: '契約ID',
  version: '枝番',
  is_active: '有効フラグ',
  status: '契約状態',
  txn_type: '取引区分',
  property_code: '物件コード',
  vendor_code: '取引先コード',
  vendor_name: '取引先名',
  contract_name: '契約名',
  department: '契約担当部門',
  person_in_charge: '契約担当者',
  trade_note: '備考（取引・管理）',
  signed_date: '契約締結日',
  service_start: 'サービス開始日',
  service_end: 'サービス終了日',
  cancel_date: '解約日',
  renewal_type: '更新区分',
  renewal_notice: '解約通知の方法・条件',
  notice_months: '解約通知（か月前）',
  renewal_term_months: '更新期間（か月）',
  first_billing_date: '初回請求日',
  billing_cycle: '請求サイクル',
  payment_timing: '当月分支払月',
  payment_method: '支払方法',
  withholding_amount: '源泉徴収税額',
  annual_payment_month: '年払い支払月',
  annual_period_note: '年払い対象期間メモ',
  amount_basis: '金額基準',
  amount_excl: '税抜契約金額',
  tax_amount: '消費税',
  amount_incl: '税込契約金額',
  note: '備考（請求・金額）',
  tax_code: '税区分',
  invoice_type: 'インボイス区分',
  recognition_method: '計上方式',
  rounding: '端数処理',
  journal_date_rule: '仕訳日ルール',
  pl_account_code: '損益科目',
  pl_sub_code: '損益補助科目',
  counter_account_code: '相手科目',
  counter_sub_code: '相手補助科目',
  annual_start_month: '年払対象開始月',
  accounting_only: '総務経理部のみ閲覧',
  ringi_no: '稟議書NO',
  contract_url: '契約書URL',
  note2: '備考（管理・証憑）',
}
