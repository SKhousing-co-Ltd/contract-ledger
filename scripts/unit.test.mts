// 画面側の計算ロジックのテスト（npm run test:unit）。依存なしで Node だけで動く
import { parseDateInput, subtractMonths } from '../src/lib/format.ts'
import { addMonthsKeepEnd, termInfo, termMonthsOf } from '../src/lib/term.ts'
import { buildJournalRows } from '../src/lib/csv.ts'

// 仕訳CSV：会計ソフトの取込サンプル（2026/9/30 総振）の行と同じ形になるか
const csvRow = (settings: Record<string, string> = {}) => buildJournalRows([{
  id: 1, period: '2026-09-01', entry_date: '2026-09-30', entry_type: 'accrual', source: 'auto', contract_id: 1, contract_no: 100001,
  dr_account: 6310, dr_sub_code: null, dr_dept: 1, dr_vendor: 902600, dr_amount: 300000, dr_tax_amount: 30000, dr_tax_code: '課税10%',
  cr_account: 3140, cr_sub_code: null, cr_dept: 1, cr_vendor: 902600, cr_amount: 330000, cr_tax_amount: 0, cr_tax_code: null,
  description: '総振　その他　10月分コンサルティング費', exported_at: null, export_batch: null,
} as never], {
  taxCodes: [{ name: '課税10%', rate: 0.1, kokuyo_tax_code: '11', kokuyo_rate_kbn: '4', sort: 1 }] as never,
  accounts: [{ code: 3140, is_accrual: true }, { code: 6310, is_accrual: false }] as never,
  setting: (k) => ({ cash_account: '1120', ...settings })[k] ?? '',
  startSlipNo: 1,
})[0].join(',')
// サンプルは貸方金額だけ "330,000" と桁区切りだが、数値としては同じ
const SAMPLE_ROW = '2026/9/30,6310,0,,902600,,1,11,4,330000,,,3140,0,,902600,,0,0,0,330000,,総振　その他　10月分コンサルティング費,,,,,'

const T = '2026-10-16'
const y = new Date().getFullYear()
const c = (o: object) => ({ cancel_date: null, service_start: null, service_end: null, renewal_type: null, renewal_term_months: null, ...o })

const cases: [string, unknown, unknown][] = [
  // 仕訳CSV
  ['csv matches sample', csvRow(), SAMPLE_ROW],
  ['csv exclusive mode', csvRow({ csv_amount_mode: 'exclusive', csv_sotozei_on: '1', csv_sotozei_off: '0' }).split(',').slice(9, 11).join('/'), '300000/30000'],
  ['csv dept column', csvRow({ csv_property_column: 'dept' }).split(',').slice(3, 7).join('/'), '1/902600//'],
  // 日付の直接入力
  ['date slash', parseDateInput('2026/10/1'), '2026-10-01'],
  ['date hyphen', parseDateInput('2026-10-01'), '2026-10-01'],
  ['date dot', parseDateInput('2026.1.5'), '2026-01-05'],
  ['date kanji', parseDateInput('2026年10月1日'), '2026-10-01'],
  ['date digits', parseDateInput('20261001'), '2026-10-01'],
  ['date fullwidth m/d', parseDateInput('１０／１'), `${y}-10-01`],
  ['date empty', parseDateInput(''), null],
  ['date feb30', parseDateInput('2026/2/30'), undefined],
  ['date text', parseDateInput('abc'), undefined],
  ['date month13', parseDateInput('2026/13/1'), undefined],
  // n か月前（月末・ローカル日付）
  ['sub monthend', subtractMonths('2027-03-31', 3), '2026-12-31'],
  ['sub clamp', subtractMonths('2027-05-31', 3), '2027-02-28'],
  ['sub year', subtractMonths('2027-01-15', 1), '2026-12-15'],
  // 契約期間
  ['term 1y', termMonthsOf('2025-04-01', '2026-03-31'), 12],
  ['term 2y', termMonthsOf('2021-08-01', '2023-07-31'), 24],
  ['term mid-month', termMonthsOf('2021-07-15', '2022-07-14'), 12],
  ['add monthend', addMonthsKeepEnd('2022-03-31', 3), '2022-06-30'],
  ['add leap', addMonthsKeepEnd('2023-02-28', 12), '2024-02-29'],
  ['add non-end', addMonthsKeepEnd('2022-07-15', 12), '2023-07-15'],
  ['kind cancel', termInfo(c({ cancel_date: '2026-12-31', service_end: '2025-01-31' }), T).kind, 'cancel'],
  ['kind none', termInfo(c({}), T).kind, 'none'],
  ['kind active', termInfo(c({ service_end: '2027-03-31', renewal_type: '自動更新' }), T).kind, 'active'],
  ['kind expired', termInfo(c({ service_end: '2026-09-30', renewal_type: '都度更新' }), T).kind, 'expired'],
  ['auto from period', termInfo(c({ service_start: '2021-08-01', service_end: '2022-07-31', renewal_type: '自動更新' }), T).date, '2027-07-31'],
  ['auto default', termInfo(c({ service_end: '2022-07-31', renewal_type: '自動更新' }), T).termSource, 'default'],
  ['auto input 6', termInfo(c({ service_end: '2025-03-31', renewal_type: '自動更新', renewal_term_months: 6 }), T).date, '2027-03-31'],
  ['auto today', termInfo(c({ service_end: '2025-10-16', renewal_type: '自動更新', renewal_term_months: 12 }), T).date, '2026-10-16'],
]

let bad = 0
for (const [name, actual, expected] of cases) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    bad++
    console.error(`NG ${name}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`)
  }
}
console.log(bad ? `UNIT TESTS FAILED (${bad}/${cases.length})` : `ALL UNIT TESTS PASSED (${cases.length})`)
process.exit(bad ? 1 : 0)
