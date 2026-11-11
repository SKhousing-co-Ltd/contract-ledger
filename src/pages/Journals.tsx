import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase, check } from '../lib/supabase'
import { useSession } from '../lib/session'
import type { JournalEntry } from '../lib/types'
import { ENTRY_TYPE_LABEL } from '../lib/types'
import { addMonths, dateJa, downloadBlob, fromMonthInput, monthLabel, monthStart, toMonthInput, yen } from '../lib/format'
import { AccountSelect, Badge, DateInput, Empty, ErrorBox, Field, Loading, MoneyInput, Notice, PageHeader, Select } from '../components/ui'

export default function Journals() {
  const s = useSession()
  const { masters, accountName, canEdit } = s
  const [params, setParams] = useSearchParams()
  const period = params.get('period') ?? monthStart()
  const [rows, setRows] = useState<JournalEntry[] | null>(null)
  const [type, setType] = useState('')
  const [exp, setExp] = useState<'' | 'no' | 'yes'>('no')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [slipNo, setSlipNo] = useState(1)
  const [markExported, setMarkExported] = useState(true)
  const [header, setHeader] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    setRows(null)
    try {
      const r = check(await supabase.from('ct_journal_entries').select('*').eq('period', period).order('entry_type').order('contract_no').order('id').range(0, 9999)) as JournalEntry[]
      setRows(r)
      setSelected(new Set())
    } catch (e) {
      setError((e as Error).message)
    }
  }, [period])

  useEffect(() => {
    load()
  }, [load])

  const shown = useMemo(
    () => (rows ?? []).filter((r) => (!type || r.entry_type === type) && (exp === '' || (exp === 'yes') === Boolean(r.exported_at))),
    [rows, type, exp],
  )
  const target = shown.filter((r) => selected.size === 0 || selected.has(r.id))
  const totals = useMemo(() => ({ dr: target.reduce((a, r) => a + Number(r.dr_amount) + Number(r.dr_tax_amount), 0) }), [target])

  function setPeriod(p: string) {
    const n = new URLSearchParams(params)
    n.set('period', p)
    setParams(n, { replace: true })
  }

  async function exportCsv() {
    setError(null)
    setMsg(null)
    if (!target.length) return
    const missing = masters.taxCodes.filter((t) => target.some((e) => e.dr_tax_code === t.name || e.cr_tax_code === t.name) && !t.kokuyo_tax_code)
    const { buildJournalRows, encodeCsv, JOURNAL_CSV_HEADER } = await import('../lib/csv')
    const rowsCsv = buildJournalRows(target, { taxCodes: masters.taxCodes, accounts: masters.accounts, setting: s.setting, startSlipNo: slipNo })
    const enc = s.setting('csv_encoding') || 'Shift_JIS'
    const data = encodeCsv(header ? [JOURNAL_CSV_HEADER, ...rowsCsv] : rowsCsv, enc)
    const batch = `${period.slice(0, 7)}_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
    downloadBlob(data as BlobPart, `仕訳_${batch}.csv`, enc.toUpperCase().includes('UTF') ? 'text/csv;charset=utf-8' : 'text/csv;charset=shift_jis')
    if (markExported) {
      const { error } = await supabase.rpc('ct_mark_exported', { p_ids: target.map((r) => r.id), p_batch: batch })
      if (error) setError(error.message)
    }
    setSlipNo(slipNo + target.length)
    setMsg(
      `${target.length} 行をCSV出力しました（文字コード ${enc}）。` +
        (missing.length ? `※税区分「${missing.map((m) => m.name).join('・')}」の会計ソフト消費税コードが未設定です（マスタ → 税区分）。` : ''),
    )
    if (markExported) load()
  }

  async function remove(ids: number[]) {
    setError(null)
    const { error } = await supabase.from('ct_journal_entries').delete().in('id', ids)
    if (error) setError(error.message)
    else load()
  }

  async function clearExported(ids: number[]) {
    const { error } = await supabase.from('ct_journal_entries').update({ exported_at: null, export_batch: null }).in('id', ids)
    if (error) setError(error.message)
    else load()
  }

  const toggle = (id: number) =>
    setSelected((s0) => {
      const n = new Set(s0)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <>
      <PageHeader
        title="仕訳・CSV出力"
        sub="月次計上で生成した仕訳と手入力の調整仕訳です。会計ソフト取込用のCSV（仕訳CSV様式・28列）を出力します。"
        actions={
          <div className="month-nav">
            <button onClick={() => setPeriod(addMonths(period, -1))}>◀</button>
            <input type="month" value={toMonthInput(period)} onChange={(e) => e.target.value && setPeriod(fromMonthInput(e.target.value))} />
            <button onClick={() => setPeriod(addMonths(period, 1))}>▶</button>
          </div>
        }
      />
      <ErrorBox error={error} />
      {msg && <Notice tone="ok">{msg}</Notice>}

      <div className="card export-box">
        <div className="row wrap">
          {s.setting('csv_slip_no') === 'sequential' && (
            <Field label="開始伝票NO">
              <input type="number" min={1} value={slipNo} onChange={(e) => setSlipNo(Number(e.target.value) || 1)} />
            </Field>
          )}
          <label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />見出し行を付ける</label>
          <label className="check"><input type="checkbox" checked={markExported} onChange={(e) => setMarkExported(e.target.checked)} />出力済みにする（作り直し対象から外す）</label>
          <span className="spacer" />
          <div className="export-sum">
            {selected.size ? `選択 ${target.length} 行` : `表示中 ${target.length} 行`}・借方合計 {yen(totals.dr)} 円
          </div>
          <button className="primary" onClick={exportCsv} disabled={!target.length}>CSV出力</button>
        </div>
      </div>

      <div className="filters">
        <Select value={type} onChange={setType} placeholder="すべての種類" options={Object.entries(ENTRY_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        <Select value={exp} onChange={(v) => setExp(v as '' | 'no' | 'yes')} placeholder="出力状況：すべて" options={[{ value: 'no', label: '未出力のみ' }, { value: 'yes', label: '出力済みのみ' }]} />
        <span className="spacer" />
        {canEdit && <button onClick={() => setShowForm((v) => !v)}>調整仕訳を追加</button>}
        {selected.size > 0 && canEdit && (
          <>
            <button onClick={() => clearExported([...selected])}>出力済みを解除</button>
            <button className="danger" onClick={() => remove([...selected].filter((id) => !rows?.find((r) => r.id === id)?.exported_at))}>選択を削除（未出力のみ）</button>
          </>
        )}
      </div>

      {showForm && <AdjustForm period={period} onDone={() => { setShowForm(false); load() }} />}

      {!rows ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Empty>
          {monthLabel(period)}の仕訳はありません。<Link to="/monthly">月次計上</Link>で生成してください。
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={selected.size > 0 && selected.size === shown.length} onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((r) => r.id)) : new Set())} />
                </th>
                <th>日付</th>
                <th>種類</th>
                <th>借方科目</th>
                <th>部門</th>
                <th className="r">借方金額</th>
                <th className="r">消費税</th>
                <th>貸方科目</th>
                <th className="r">貸方金額</th>
                <th>摘要</th>
                <th>出力</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? 'selected' : ''}>
                  <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td className="nowrap mono small">{dateJa(r.entry_date)}</td>
                  <td className="nowrap">
                    <Badge tone={r.entry_type === 'accrual' ? 'info' : r.entry_type === 'payment' ? 'neutral' : 'warn'}>{ENTRY_TYPE_LABEL[r.entry_type]}</Badge>
                    {r.source === 'manual' && <span className="tag">手入力</span>}
                  </td>
                  <td className="nowrap small">{r.dr_account} {accountName(r.dr_account)}</td>
                  <td className="nowrap small">{r.dr_dept}</td>
                  <td className="r mono">{yen(r.dr_amount)}</td>
                  <td className="r mono small">{r.dr_tax_amount ? yen(r.dr_tax_amount) : r.cr_tax_amount ? `(貸)${yen(r.cr_tax_amount)}` : ''}</td>
                  <td className="nowrap small">{r.cr_account} {accountName(r.cr_account)}</td>
                  <td className="r mono">{yen(r.cr_amount)}</td>
                  <td className="ellipsis small" title={r.description ?? ''}>
                    {r.contract_id ? <Link to={`/contracts/${r.contract_id}`}>{r.description}</Link> : r.description}
                  </td>
                  <td className="small nowrap">{r.exported_at ? <Badge tone="ok">済</Badge> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function AdjustForm({ period, onDone }: { period: string; onDone: () => void }) {
  const { masters } = useSession()
  const [date, setDate] = useState(() => {
    const [y, m] = period.split('-').map(Number)
    return new Date(y, m, 0).toLocaleDateString('sv-SE')
  })
  const [contractNo, setContractNo] = useState('')
  const [dr, setDr] = useState<number | null>(null)
  const [cr, setCr] = useState<number | null>(null)
  const [dept, setDept] = useState('')
  const [amount, setAmount] = useState<number | null>(null)
  const [desc, setDesc] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!dr || !cr || !amount) {
      setError('借方科目・貸方科目・金額を入力してください')
      return
    }
    const { error } = await supabase.from('ct_journal_entries').insert({
      period,
      entry_date: date,
      entry_type: 'adjust',
      source: 'manual',
      contract_no: contractNo ? Number(contractNo) : null,
      dr_account: dr,
      dr_dept: dept ? Number(dept) : null,
      dr_amount: amount,
      cr_account: cr,
      cr_dept: dept ? Number(dept) : null,
      cr_amount: amount,
      description: desc,
    })
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <div className="card inline-form">
      <h2>調整仕訳（税なし・1行）</h2>
      <p className="muted small">経過勘定残高の調整に使います。契約IDを入れると、その契約の残高に反映されます。</p>
      <ErrorBox error={error} />
      <div className="grid">
        <Field label="日付"><DateInput value={date || null} onChange={(v) => setDate(v ?? '')} /></Field>
        <Field label="契約ID（任意）"><input className="mono" value={contractNo} onChange={(e) => setContractNo(e.target.value)} /></Field>
        <Field label="部門（物件コード）">
          <Select value={dept} onChange={setDept} options={masters.properties.map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }))} />
        </Field>
        <Field label="借方科目"><AccountSelect value={dr} onChange={setDr} accounts={masters.accounts} /></Field>
        <Field label="貸方科目"><AccountSelect value={cr} onChange={setCr} accounts={masters.accounts} /></Field>
        <Field label="金額"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="摘要" wide><input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      </div>
      <div className="row">
        <button className="primary" onClick={save}>追加</button>
        <button onClick={onDone}>やめる</button>
      </div>
    </div>
  )
}
