import Encoding from 'encoding-japanese'
import type { Account, JournalEntry, Property, TaxCode } from './types'
import { csvCell } from './format'

/** シート「仕訳CSV」と同じ28列 */
export const JOURNAL_CSV_HEADER = [
  '伝票日付', '借方科目コード', '借方科目別補助コード', '借方部門コード', '借方取引先コード', '借方銀行コード', '借方ｾｸﾞﾒﾝﾄ1コード',
  '(コクヨ)借方消費税コード', '(コクヨ)借方消費税率区分', '(コクヨ)借方金額', '(コクヨ)借方消費税額', '期日',
  '貸方科目コード', '貸方科目別補助コード', '貸方部門コード', '貸方取引先コード', '貸方銀行コード', '貸方ｾｸﾞﾒﾝﾄ1コード',
  '(コクヨ)貸方消費税コード', '(コクヨ)貸方消費税率区分', '(コクヨ)貸方金額', '(コクヨ)貸方消費税額',
  '摘要', 'ダミー項目', '伝票NO', '仕訳入力形式', '(コクヨ)借方外税同時入力区分', '(コクヨ)貸方外税同時入力区分',
]

export interface CsvOptions {
  taxCodes: TaxCode[]
  accounts: Account[]
  properties: Pick<Property, 'code' | 'kind' | 'is_residential'>[]
  setting: (key: string) => string
  startSlipNo: number
}

/**
 * 課税仕入の消費税コード（個別対応方式の区分）。会計ソフトのサンプル3種（計300行）から決めた決まり：
 *   原価（5000番台）× オフィスビル・ホテルなど → 税区分マスタのコード（課税売上対応＝10）
 *   原価（5000番台）× 住宅・寮                  → 共通対応（11）
 *   販管費（6000番台）                           → 共通対応（11）
 * 住宅は物件マスタの「住宅」フラグ（区分は集計用に「ビル」のまま）、寮は区分「寮・社宅」で判定する。
 * 消費税率区分は税区分マスタのまま（10%＝4、軽減8%＝5）。
 */
export function purchaseTaxCode(baseCode: string, account: number, property: Pick<Property, 'kind' | 'is_residential'> | undefined, o: {
  commonCode: string; baseTaxableCode: string; commonKinds: string[]
}): string {
  if (baseCode !== o.baseTaxableCode) return baseCode
  const sga = account >= 6000 && account < 7000
  const residential = Boolean(property?.is_residential) || (property !== undefined && o.commonKinds.includes(property.kind))
  return sga || residential ? o.commonCode : baseCode
}

/**
 * 出力形式の既定値は、会計ソフトの取込サンプル（2026/9/30 の総振仕訳）に合わせている。設定（ct_settings）で変えられる。
 *  - csv_amount_mode     inclusive（既定）… 金額は税込、消費税額・外税同時入力区分は空欄（内税）
 *                        exclusive        … 金額は税抜、消費税額を出し、外税同時入力区分に csv_sotozei_on/off
 *  - csv_property_column segment1（既定）… 物件コードをセグメント1へ（部門コードは空欄）／ dept … 部門コードへ
 *  - csv_counter_segment 経過勘定・預金の側のセグメント（既定 0）
 *  - csv_sub_default     補助科目が無いときの値（既定 0）
 *  - csv_sub_by_account  科目ごとの補助科目「科目:補助」をカンマ区切り（既定 3150:9,1550:1）。
 *                        仕訳・契約に補助科目が入っていればそちらを優先し、無いときにこの対応表、それも無ければ csv_sub_default
 *  - csv_tax_code_none / csv_rate_kbn_none 消費税の無い側のコード（既定 0 / 0）
 *  - csv_slip_no         blank（既定。会計ソフトで採番）／ sequential … 画面で指定した番号から連番
 *  - csv_date_format     yyyy/M/d（既定）／ yyyy/MM/dd ／ yyyyMMdd
 *  - csv_tax_code_taxable 課税売上対応の消費税コード（既定 10）。これを共通対応へ切り替える対象にする
 *  - csv_tax_code_common  共通対応の消費税コード（既定 11）
 *  - csv_common_kinds     共通対応にする物件区分（既定「寮・社宅」）。住宅は物件の「住宅」フラグで判定
 * 損益科目でない科目（立替金・仮払金 などを費用側に使う場合）は消費税コード・率区分とも 0 にする。
 */
export const CSV_DEFAULTS: Record<string, string> = {
  csv_amount_mode: 'inclusive',
  csv_property_column: 'segment1',
  csv_counter_segment: '0',
  csv_sub_default: '0',
  csv_sub_by_account: '3150:9,1550:1',
  csv_tax_code_none: '0',
  csv_rate_kbn_none: '0',
  csv_slip_no: 'blank',
  csv_date_format: 'yyyy/M/d',
  csv_tax_code_taxable: '10',
  csv_tax_code_common: '11',
  csv_common_kinds: '寮・社宅',
}

export function fmtDate(iso: string, pattern: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  if (pattern === 'yyyyMMdd') return `${y}${m}${d}`
  if (pattern === 'yyyy/MM/dd') return `${y}/${m}/${d}`
  return `${y}/${Number(m)}/${Number(d)}`
}

export function buildJournalRows(entries: JournalEntry[], o: CsvOptions): string[][] {
  const get = (k: string) => o.setting(k) || CSV_DEFAULTS[k] || ''
  const tax = new Map(o.taxCodes.map((t) => [t.name, t]))
  const acc = new Map(o.accounts.map((a) => [a.code, a]))
  const cash = Number(o.setting('cash_account')) || null
  const inclusive = get('csv_amount_mode') !== 'exclusive'
  const toSegment = get('csv_property_column') !== 'dept'
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  const props = new Map(o.properties.map((p) => [p.code, p]))
  const common = {
    baseTaxableCode: get('csv_tax_code_taxable'),
    commonCode: get('csv_tax_code_common'),
    commonKinds: get('csv_common_kinds').split(',').map((x) => x.trim()).filter(Boolean),
  }

  // 科目ごとの補助科目（例：3150 未払費用 → 9、1550 前払費用 → 1）
  const subByAccount = new Map(
    get('csv_sub_by_account').split(',').map((x) => x.split(':').map((y) => y.trim())).filter(([a, b]) => a && b).map(([a, b]) => [Number(a), b]),
  )

  // 経過勘定（未払金・未払費用・前払費用 など）と預金の側は物件で分けない
  const isCounter = (code: number) => code === cash || Boolean(acc.get(code)?.is_accrual)

  const side = (account: number, sub: string | null, dept: number | null, vendor: number | null,
    amount: number, taxAmount: number, taxName: string | null) => {
    // 損益科目でない側（経過勘定・預金・立替金など）は消費税コードを付けない
    const t = taxName && acc.get(account)?.bs_pl !== 'BS' ? tax.get(taxName) : undefined
    const property = isCounter(account) ? get('csv_counter_segment') : s(dept)
    const taxCode = t ? purchaseTaxCode(s(t.kokuyo_tax_code), account, dept == null ? undefined : props.get(dept), common) : ''
    const taxAmt = Number(taxAmount || 0)
    return {
      // 科目, 補助, 部門, 取引先, 銀行, セグメント1, 消費税コード, 消費税率区分
      cols: [
        s(account), sub || subByAccount.get(account) || get('csv_sub_default'), toSegment ? '' : property, s(vendor), '', toSegment ? property : '',
        t ? taxCode : get('csv_tax_code_none'), t ? s(t.kokuyo_rate_kbn) : get('csv_rate_kbn_none'),
      ],
      amount: String(Number(amount) + (inclusive ? taxAmt : 0)),
      tax: inclusive || !taxAmt ? '' : String(taxAmt),
      sotozei: inclusive ? '' : taxAmt ? get('csv_sotozei_on') : get('csv_sotozei_off'),
    }
  }

  return entries.map((e, i) => {
    const dr = side(e.dr_account, e.dr_sub_code, e.dr_dept, e.dr_vendor, e.dr_amount, e.dr_tax_amount, e.dr_tax_code)
    const cr = side(e.cr_account, e.cr_sub_code, e.cr_dept, e.cr_vendor, e.cr_amount, e.cr_tax_amount, e.cr_tax_code)
    return [
      fmtDate(e.entry_date, get('csv_date_format')),
      ...dr.cols, dr.amount, dr.tax, '',
      ...cr.cols, cr.amount, cr.tax,
      s(e.description), '', get('csv_slip_no') === 'sequential' ? String(o.startSlipNo + i) : '', o.setting('csv_input_format'),
      dr.sotozei, cr.sotozei,
    ]
  })
}

export function encodeCsv(rows: string[][], encoding: string): Uint8Array | string {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  if (encoding.toUpperCase().replace('-', '_') === 'SHIFT_JIS' || encoding.toUpperCase() === 'SJIS') {
    const codes = Encoding.convert(Encoding.stringToCode(text), { to: 'SJIS', from: 'UNICODE' })
    return new Uint8Array(codes)
  }
  return '﻿' + text
}
