// 画面側の計算ロジックのテスト（npm run test:unit）。依存なしで Node だけで動く
import { parseDateInput, subtractMonths } from '../src/lib/format.ts'
import { addMonthsKeepEnd, termInfo, termMonthsOf } from '../src/lib/term.ts'
import { buildJournalRows } from '../src/lib/csv.ts'
import { IMPORT_COLUMNS, parseCsv, readImport, templateRows } from '../src/lib/contractImport.ts'

// 契約の一括取り込み：テンプレートに1行足した CSV を読む
const importMasters = {
  properties: [
    { code: 1, name: '本社', kind: '本社', is_residential: false, accounting_only: true, is_active: true, sort: 0 },
    { code: 17, name: '肥後橋', kind: 'ビル', is_residential: false, accounting_only: false, is_active: true, sort: 1 },
  ],
  accounts: [
    { code: 5310, name: '管理費(BM)Ⅰ', short_name: null, bs_pl: 'PL', normal_side: '借方', is_accrual: false, is_active: true },
    { code: 3150, name: '未払費用', short_name: null, bs_pl: 'BS', normal_side: '貸方', is_accrual: true, is_active: true },
    { code: 1550, name: '前払費用', short_name: null, bs_pl: 'BS', normal_side: '借方', is_accrual: true, is_active: true },
  ],
  vendors: [{ code: 403300, name: '東芝エレベーター株式会社', note: null }],
  taxCodes: [{ name: '課税10%', rate: 0.1, kokuyo_tax_code: '10', kokuyo_rate_kbn: '4', sort: 1 }],
  options: (cat: string) => ({
    status: ['契約中', '解約予定', '解約済'], txn_type: ['費用', '収益'], department: ['管理部', '総務経理部'], renewal_type: ['自動更新', '都度更新'],
    billing_cycle: ['月次', '年次', '半年'], payment_timing: ['当月払い', '翌月払い', '年払い'], payment_method: ['月末総振', '振込'],
    amount_basis: ['月額', '年額', '一括', '従量'], invoice_type: ['適格'], recognition_method: ['月割'], journal_date_rule: ['月末'],
  } as Record<string, string[]>)[cat] ?? [],
  isAccounting: false,
} as never
const importRow = (over: Record<string, string>) => {
  const [head, example] = templateRows()
  const row = IMPORT_COLUMNS.map((c) => over[c.label] ?? '')
  return readImport(parseCsv([head, example, row].map((r) => r.map((v) => `"${v}"`).join(',')).join('\r\n')), importMasters).rows
}
const okRow = importRow({ '物件コード': '１７', '契約名': '昇降機保守（FM）', '取引先コード': '403300', '請求サイクル': '月次', '当月分支払月': '翌月払い',
  '金額基準': '月額', '税抜契約金額': '31,000', '損益科目コード': '5310', 'サービス開始日': '２０２６年１１月１日' })
const yearRow = importRow({ '物件コード': '17', '契約名': '年払い保守', '請求サイクル': '年次', '当月分支払月': '年払い', '金額基準': '月額',
  '税抜契約金額': '120000', '損益科目コード': '5310' })
const ngRow = importRow({ '物件コード': '1', '契約名': '本社の契約', '取引先コード': '999999', '請求サイクル': '月次', '当月分支払月': '翌月払い',
  '金額基準': '月額', '税抜契約金額': 'abc', '損益科目コード': '5310', '支払方法': 'クレジット' })

// 仕訳CSV：会計ソフトの取込サンプル（サンプル1〜3）の行と同じ形になるか
const csvRow = (settings: Record<string, string> = {}, e: Record<string, unknown> = {}) => buildJournalRows([{
  id: 1, period: '2026-09-01', entry_date: '2026-09-30', entry_type: 'accrual', source: 'auto', contract_id: 1, contract_no: 100001,
  dr_account: 6310, dr_sub_code: null, dr_dept: 1, dr_vendor: 902600, dr_amount: 300000, dr_tax_amount: 30000, dr_tax_code: '課税10%',
  cr_account: 3140, cr_sub_code: null, cr_dept: 1, cr_vendor: 902600, cr_amount: 330000, cr_tax_amount: 0, cr_tax_code: null,
  description: '総振　その他　10月分コンサルティング費', exported_at: null, export_batch: null, ...e,
} as never], {
  // 税区分マスタには課税売上対応のコード（10）を登録しておき、科目・物件で共通対応（11）に切り替える
  taxCodes: [
    { name: '課税10%', rate: 0.1, kokuyo_tax_code: '10', kokuyo_rate_kbn: '4', sort: 1 },
    { name: '軽減8%', rate: 0.08, kokuyo_tax_code: '10', kokuyo_rate_kbn: '5', sort: 2 },
    { name: '不課税', rate: 0, kokuyo_tax_code: '40', kokuyo_rate_kbn: '0', sort: 3 },
  ] as never,
  accounts: [
    { code: 3140, bs_pl: 'BS', is_accrual: true }, { code: 1520, bs_pl: 'BS', is_accrual: false },
    { code: 6310, bs_pl: 'PL', is_accrual: false }, { code: 5310, bs_pl: 'PL', is_accrual: false }, { code: 5000, bs_pl: 'PL', is_accrual: false },
  ] as never,
  properties: [
    { code: 1, kind: '本社', is_residential: false }, { code: 11, kind: 'ビル', is_residential: false },
    { code: 26, kind: 'ビル', is_residential: true }, { code: 202, kind: 'ホテル', is_residential: false }, { code: 402, kind: '寮・社宅', is_residential: false },
  ],
  setting: (k) => ({ cash_account: '1120', ...settings })[k] ?? '',
  startSlipNo: 1,
})[0].join(',')
// サンプル1の1行目（貸方金額だけ "330,000" と桁区切りだが、数値としては同じ）
const SAMPLE_ROW = '2026/9/30,6310,0,,902600,,1,11,4,330000,,,3140,0,,902600,,0,0,0,330000,,総振　その他　10月分コンサルティング費,,,,,'
// 借方の消費税コード／率区分だけ取り出す
const drTax = (e: Record<string, unknown>) => csvRow({}, e).split(',').slice(7, 9).join('/')

const T = '2026-10-16'
const y = new Date().getFullYear()
const c = (o: object) => ({ cancel_date: null, service_start: null, service_end: null, renewal_type: null, renewal_term_months: null, ...o })

const cases: [string, unknown, unknown][] = [
  // 契約の一括取り込み
  ['import skips example row', okRow.length, 1],
  ['import skips old-style example row', readImport(parseCsv(['物件コード*,契約名*,請求サイクル*,当月分支払月*,金額基準*,損益科目コード*', '11,保守料（記入例・この行は取り込まれません）,月次,翌月払い,月額,5310'].join('\r\n')), importMasters).rows.length, 0],
  ['template example row', templateRows()[1].slice(0, 2), ['記入例', 'エレベーター保守料']],
  ['import ok row has no errors', okRow[0].errors, []],
  ['import values', [okRow[0].values.property_code, okRow[0].values.amount_excl, okRow[0].values.tax_amount, okRow[0].values.service_start],
    [17, 31000, 3100, '2026-11-01']],
  ['import defaults', [okRow[0].values.is_active, okRow[0].values.status, okRow[0].values.payment_method, okRow[0].values.tax_code, okRow[0].values.renewal_type],
    [true, '契約中', '月末総振', '課税10%', '自動更新']],
  ['import vendor name from master', okRow[0].values.vendor_name, '東芝エレベーター株式会社'],
  ['import counter suggested', okRow[0].values.counter_account_code, 3150],
  ['import contract name kept as typed', okRow[0].values.contract_name, '昇降機保守（FM）'],
  ['import yearly rules', yearRow[0].errors, ['年次・半年の契約は年払い支払月が必須です', '年次・半年の契約は年払対象開始月が必須です', '年次・半年の契約は金額基準を「年額」か「一括」にしてください']],
  ['import errors', ngRow[0].errors, [
    '支払方法「クレジット」はマスタにありません（月末総振・振込）',
    '税抜契約金額「abc」が数値ではありません',
    '物件「本社」は総務経理部のみ登録できます',
    '取引先コード 999999 は取引先マスタに無いため、取引先名も入力してください',
  ]],
  ['import missing columns', readImport(parseCsv('物件コード,契約名\r\n17,テスト'), importMasters).missingColumns, ['請求サイクル', '当月分支払月', '金額基準', '損益科目コード']],
  // 仕訳CSV
  ['csv matches sample', csvRow(), SAMPLE_ROW],
  ['csv exclusive mode', csvRow({ csv_amount_mode: 'exclusive', csv_sotozei_on: '1', csv_sotozei_off: '0' }).split(',').slice(9, 11).join('/'), '300000/30000'],
  ['csv dept column', csvRow({ csv_property_column: 'dept' }).split(',').slice(3, 7).join('/'), '1/902600//'],
  ['tax 販管費 → 11', drTax({}), '11/4'],
  ['tax 原価×ビル → 10', drTax({ dr_account: 5310, dr_dept: 11 }), '10/4'],
  ['tax 原価×住宅（区分ビル） → 11', drTax({ dr_account: 5310, dr_dept: 26 }), '11/4'],
  ['tax 原価×寮 → 11', drTax({ dr_account: 5310, dr_dept: 402 }), '11/4'],
  ['tax 原価×ホテル 軽減 → 10/5', drTax({ dr_account: 5000, dr_dept: 202, dr_tax_code: '軽減8%' }), '10/5'],
  ['tax 販管費 軽減 → 11/5', drTax({ dr_tax_code: '軽減8%' }), '11/5'],
  ['tax 不課税 → 40/0', drTax({ dr_account: 5310, dr_dept: 26, dr_tax_code: '不課税' }), '40/0'],
  ['tax 立替金 → 0/0', drTax({ dr_account: 1520 }), '0/0'],
  // 補助科目：未払費用 3150 → 9、前払費用 1550 → 1、未払金 3140 は 0。個別の補助科目があればそちら
  ['sub 3150 → 9', csvRow({}, { cr_account: 3150 }).split(',')[13], '9'],
  ['sub 1550 → 1', csvRow({}, { dr_account: 1550, cr_account: 1120 }).split(',')[2], '1'],
  ['sub 3140 → 0', csvRow().split(',')[13], '0'],
  ['sub entry wins', csvRow({}, { cr_account: 3150, cr_sub_code: '5' }).split(',')[13], '5'],
  ['sub table setting', csvRow({ csv_sub_by_account: '3150:2' }, { cr_account: 3150 }).split(',')[13], '2'],
  ['tax 寮を対象外に設定', csvRow({ csv_common_kinds: 'その他' }, { dr_account: 5310, dr_dept: 402 }).split(',').slice(7, 9).join('/'), '10/4'],
  ['tax 住宅フラグは区分設定に関係なく11', csvRow({ csv_common_kinds: 'その他' }, { dr_account: 5310, dr_dept: 26 }).split(',').slice(7, 9).join('/'), '11/4'],
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
