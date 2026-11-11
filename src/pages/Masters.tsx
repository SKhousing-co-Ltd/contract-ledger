import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useSession } from '../lib/session'
import { ErrorBox, Notice, PageHeader } from '../components/ui'

type ColType = 'text' | 'number' | 'bool' | 'select'
interface Col {
  key: string
  label: string
  type?: ColType
  options?: string[]
  width?: number
  readonlyExisting?: boolean
}
interface TableDef {
  id: string
  label: string
  table: string
  pk: string[]
  cols: Col[]
  hint: string
  rows: (m: ReturnType<typeof useSession>['masters']) => Record<string, unknown>[]
  editable: 'master' | 'editor'
}

const DEFS: TableDef[] = [
  {
    id: 'properties', label: '物件', table: 'ct_properties', pk: ['code'], editable: 'master',
    hint: '物件コードは仕訳CSVの「部門コード」として出力されます。「経理のみ」をオンにした物件の契約は、総務経理部だけが閲覧できます。',
    cols: [
      { key: 'code', label: '物件コード', type: 'number', width: 100, readonlyExisting: true },
      { key: 'name', label: '物件名' },
      { key: 'kind', label: '区分', type: 'select', options: ['ビル', 'ホテル', '寮・社宅', '本社', '土地・その他', 'その他'] },
      { key: 'accounting_only', label: '経理のみ', type: 'bool' },
      { key: 'is_active', label: '使用中', type: 'bool' },
      { key: 'sort', label: '並び順', type: 'number', width: 80 },
    ],
    rows: (m) => m.properties as unknown as Record<string, unknown>[],
  },
  {
    id: 'vendors', label: '取引先', table: 'ct_vendors', pk: ['code'], editable: 'editor',
    hint: '取引先コードは会計ソフトの取引先コードと合わせてください（仕訳CSVの取引先コード列に出力）。',
    cols: [
      { key: 'code', label: '取引先コード', type: 'number', width: 120, readonlyExisting: true },
      { key: 'name', label: '取引先名' },
      { key: 'note', label: 'メモ' },
    ],
    rows: (m) => m.vendors as unknown as Record<string, unknown>[],
  },
  {
    id: 'accounts', label: '勘定科目', table: 'ct_accounts', pk: ['code'], editable: 'master',
    hint: '「経過勘定」をオンにした科目が、経過勘定残高の画面で残高管理されます（初期値：1550 前払費用・3140 未払金・3150 未払費用・1530 未収入金・3160 前受金）。',
    cols: [
      { key: 'code', label: 'コード', type: 'number', width: 90, readonlyExisting: true },
      { key: 'name', label: '正式科目名' },
      { key: 'short_name', label: '簡略名' },
      { key: 'bs_pl', label: 'BS/PL', type: 'select', options: ['BS', 'PL'], width: 80 },
      { key: 'normal_side', label: '正残', type: 'select', options: ['借方', '貸方'], width: 80 },
      { key: 'is_accrual', label: '経過勘定', type: 'bool' },
      { key: 'is_active', label: '使用', type: 'bool' },
    ],
    rows: (m) => m.accounts as unknown as Record<string, unknown>[],
  },
  {
    id: 'tax', label: '税区分', table: 'ct_tax_codes', pk: ['name'], editable: 'master',
    hint: '会計ソフト（コクヨ形式）の消費税コード・消費税率区分を設定してください。仕訳CSVの「(コクヨ)消費税コード／消費税率区分」に出力されます。',
    cols: [
      { key: 'name', label: '税区分', readonlyExisting: true },
      { key: 'rate', label: '税率', type: 'number', width: 80 },
      { key: 'kokuyo_tax_code', label: '会計ソフト 消費税コード' },
      { key: 'kokuyo_rate_kbn', label: '会計ソフト 消費税率区分' },
      { key: 'sort', label: '並び順', type: 'number', width: 80 },
    ],
    rows: (m) => m.taxCodes as unknown as Record<string, unknown>[],
  },
  {
    id: 'codes', label: '選択肢', table: 'ct_code_values', pk: ['category', 'value'], editable: 'master',
    hint: '契約画面のプルダウンの選択肢です。「請求サイクル」「金額基準」「支払月」の値は計上ロジックで使うため、既存の値の名前は変えないでください。',
    cols: [
      { key: 'category', label: '分類', readonlyExisting: true, type: 'select', options: ['status', 'txn_type', 'renewal_type', 'billing_cycle', 'payment_timing', 'payment_method', 'amount_basis', 'invoice_type', 'recognition_method', 'rounding', 'journal_date_rule', 'department'] },
      { key: 'value', label: '値', readonlyExisting: true },
      { key: 'sort', label: '並び順', type: 'number', width: 80 },
    ],
    rows: (m) => m.codeValues as unknown as Record<string, unknown>[],
  },
  {
    id: 'settings', label: '設定', table: 'ct_settings', pk: ['key'], editable: 'master',
    hint: '仕訳生成・CSV出力の設定です。',
    cols: [
      { key: 'key', label: 'キー', readonlyExisting: true, width: 180 },
      { key: 'label', label: '説明' },
      { key: 'value', label: '値', width: 160 },
    ],
    rows: (m) => m.settings as unknown as Record<string, unknown>[],
  },
]

const CATEGORY_LABEL: Record<string, string> = {
  status: '契約状態', txn_type: '取引区分', renewal_type: '更新区分', billing_cycle: '請求サイクル', payment_timing: '支払月', payment_method: '支払方法',
  amount_basis: '金額基準', invoice_type: 'インボイス区分', recognition_method: '計上方式', rounding: '端数処理', journal_date_rule: '仕訳日ルール', department: '担当部署',
}

export default function Masters() {
  const s = useSession()
  const [tab, setTab] = useState('properties')
  const def = DEFS.find((d) => d.id === tab)!
  const canWrite = def.editable === 'editor' ? s.canEdit : s.isAdmin || (s.isAccounting && s.canEdit)
  return (
    <>
      <PageHeader title="マスタ" sub="物件・取引先・勘定科目・税区分・選択肢・設定" />
      <div className="tabs">
        {DEFS.map((d) => (
          <button key={d.id} className={tab === d.id ? 'on' : ''} onClick={() => setTab(d.id)}>{d.label}</button>
        ))}
      </div>
      <MasterTable key={def.id} def={def} canWrite={canWrite} />
    </>
  )
}

function MasterTable({ def, canWrite }: { def: TableDef; canWrite: boolean }) {
  const { masters, reloadMasters } = useSession()
  const base = useMemo(() => def.rows(masters), [def, masters])
  const [rows, setRows] = useState<Record<string, unknown>[]>(base)
  const [isNew, setIsNew] = useState<Set<number>>(new Set())
  const [dirty, setDirty] = useState<Set<number>>(new Set())
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    setRows(base)
    setDirty(new Set())
    setIsNew(new Set())
  }, [base])

  const visible = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => isNew.has(i) || !q || Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q.toLowerCase())))

  function edit(i: number, k: string, v: unknown) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
    setDirty((d) => new Set(d).add(i))
  }

  async function saveAll() {
    setError(null)
    setMsg(null)
    const payload = [...dirty].map((i) => {
      const r: Record<string, unknown> = {}
      def.cols.forEach((c) => {
        const v = rows[i][c.key]
        r[c.key] = v === '' ? null : v
      })
      return r
    })
    if (payload.some((p) => def.pk.some((k) => p[k] === null || p[k] === undefined))) {
      setError(`${def.cols.filter((c) => def.pk.includes(c.key)).map((c) => c.label).join('・')}は必須です`)
      return
    }
    const { error } = await supabase.from(def.table).upsert(payload, { onConflict: def.pk.join(',') })
    if (error) setError(error.message.includes('row-level') ? '編集権限がありません' : error.message)
    else {
      setMsg(`${payload.length} 件保存しました`)
      await reloadMasters()
    }
  }

  async function remove(i: number) {
    if (isNew.has(i)) {
      setRows((rs) => rs.filter((_, j) => j !== i))
      return
    }
    let qb = supabase.from(def.table).delete()
    def.pk.forEach((k) => (qb = qb.eq(k, rows[i][k] as string)))
    const { error } = await qb
    if (error) setError(error.message.includes('foreign key') ? '契約や仕訳で使われているため削除できません（「使用」をオフにしてください）' : error.message)
    else await reloadMasters()
  }

  function addRow() {
    const blank: Record<string, unknown> = {}
    def.cols.forEach((c) => (blank[c.key] = c.type === 'bool' ? (c.key === 'is_active' ? true : false) : c.type === 'number' ? null : ''))
    setRows((rs) => [blank, ...rs])
    setIsNew((n) => new Set([0, ...[...n].map((x) => x + 1)]))
    setDirty((d) => new Set([0, ...[...d].map((x) => x + 1)]))
  }

  return (
    <section className="card">
      <p className="muted small">{def.hint}</p>
      <ErrorBox error={error} />
      {msg && <Notice tone="ok">{msg}</Notice>}
      {!canWrite && <Notice>閲覧のみです（編集は管理者・総務経理部の編集権限が必要です）。</Notice>}
      <div className="filters">
        <input className="search" placeholder="絞り込み" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        {canWrite && <button onClick={addRow}>行を追加</button>}
        {canWrite && <button className="primary" onClick={saveAll} disabled={!dirty.size}>変更を保存（{dirty.size}）</button>}
      </div>
      <div className="table-wrap tall">
        <table className="data compact master">
          <thead>
            <tr>
              {def.cols.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}
              {canWrite && <th style={{ width: 60 }} />}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ r, i }) => (
              <tr key={i} className={dirty.has(i) ? 'dirty' : ''}>
                {def.cols.map((c) => {
                  const ro = !canWrite || (c.readonlyExisting && !isNew.has(i))
                  const v = r[c.key]
                  if (c.type === 'bool')
                    return <td key={c.key} className="c"><input type="checkbox" checked={Boolean(v)} disabled={ro} onChange={(e) => edit(i, c.key, e.target.checked)} /></td>
                  if (c.type === 'select')
                    return (
                      <td key={c.key}>
                        <select value={String(v ?? '')} disabled={ro} onChange={(e) => edit(i, c.key, e.target.value)}>
                          <option value="">—</option>
                          {c.options!.map((o) => <option key={o} value={o}>{CATEGORY_LABEL[o] ?? o}</option>)}
                        </select>
                      </td>
                    )
                  return (
                    <td key={c.key}>
                      <input
                        className={c.type === 'number' ? 'num' : ''}
                        value={v === null || v === undefined ? '' : String(v)}
                        disabled={ro}
                        onChange={(e) => edit(i, c.key, c.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
                      />
                    </td>
                  )
                })}
                {canWrite && <td><button className="small" onClick={() => remove(i)}>削除</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
