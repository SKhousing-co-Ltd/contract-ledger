import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase, check } from '../lib/supabase'
import { useSession } from '../lib/session'
import type { Allocation, Contract, ContractItem, HistoryRow } from '../lib/types'
import { FIELD_LABELS } from '../lib/types'
import { dateJa, subtractMonths, yen } from '../lib/format'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { PAYMENT_TIMINGS, nextCounterSub, suggestCounter, withholdingTax } from '../lib/contractRules'
import { TERM_SOURCE_LABEL, termInfo, todayIso } from '../lib/term'
import { AccountSelect, Badge, DateInput, ErrorBox, Field, Loading, MoneyInput, Notice, PageHeader, Select, judgementTone } from '../components/ui'

/** マスタから消した値でも、登録済みの契約では選択肢に残す（保存時に消えないように） */
const withCurrent = (opts: string[], current: string | null | undefined) =>
  current && !opts.includes(current) ? [...opts, current] : opts

const MONTHS = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}月` }))

const blank = (): Partial<Contract> => ({
  version: 1,
  is_active: true,
  status: '契約中',
  txn_type: '費用',
  billing_cycle: '月次',
  payment_timing: '翌月払い',
  amount_basis: '月額',
  tax_code: '課税10%',
  invoice_type: '適格',
  recognition_method: '月割',
  rounding: '初月調整',
  journal_date_rule: '月末',
  renewal_type: '自動更新',
  counter_account_code: 3150,
  counter_sub_code: '9',
  accounting_only: false,
})

const EDITABLE_KEYS = Object.keys(FIELD_LABELS).filter((k) => k !== 'amount_incl') as (keyof Contract)[]

/** 未保存の変更の判定に使う、入力内容の写し（自動で決まる契約ID・閲覧制限は除く。空文字は未入力と同じ扱い） */
const blankToNull = (v: unknown) => (v === '' || v === undefined ? null : v)
const snapshotOf = (f: Partial<Contract>, it: ContractItem[]) =>
  JSON.stringify({
    // 契約金額・損益科目は「金額の内訳」から決まるので、内訳の側で比べる
    f: EDITABLE_KEYS.filter((k) => !['contract_no', 'accounting_only', 'amount_excl', 'pl_account_code', 'pl_sub_code'].includes(k)).map((k) => blankToNull(f[k])),
    it: it.map((x) => [blankToNull(x.item_name), blankToNull(x.amount_excl), blankToNull(x.pl_account_code), blankToNull(x.pl_sub_code), blankToNull(x.property_code)]),
  })

/**
 * 金額の内訳（明細）。1行 ＝ 計上仕訳1行（物件 × 損益科目 × 税抜金額）。
 * 明細が保存されていない契約は「契約の物件 × 契約の科目 × 契約金額」の1行として表示する。
 * 物件が空の行は契約の物件。
 */
function linesOf(c: Partial<Contract>, items: ContractItem[], allocs: Allocation[] = []): ContractItem[] {
  const acc = items.filter((x) => x.pl_account_code != null)
  if (acc.length) return acc.map((x, i) => ({ ...x, property_code: x.property_code ?? c.property_code ?? null, sort: i }))
  // 旧来の按分しか無い契約は、按分先の物件 × 契約の科目の行として表示する（保存すると明細になる）
  if (allocs.length)
    return allocs.map((a, i) => ({ item_name: a.label ?? '', amount_excl: a.amount_excl, note: null, sort: i,
      pl_account_code: c.pl_account_code ?? null, pl_sub_code: c.pl_sub_code ?? null, property_code: a.property_code }))
  return [{ item_name: '', amount_excl: c.amount_excl ?? null, note: null, sort: 0,
    pl_account_code: c.pl_account_code ?? null, pl_sub_code: c.pl_sub_code ?? null, property_code: c.property_code ?? null }]
}

export default function ContractEdit() {
  const { id } = useParams()
  const isNew = !id
  const nav = useNavigate()
  const s = useSession()
  const { masters, options, canEdit, isAccounting } = s

  const [form, setForm] = useState<Partial<Contract>>(blank())
  // 金額の内訳（明細）。按分・科目明細をまとめた表
  const [items, setItems] = useState<ContractItem[]>(linesOf(blank(), []))
  const [cancelDraft, setCancelDraft] = useState<{ date: string | null; memo: string } | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [versions, setVersions] = useState<Contract[]>([])
  const [loading, setLoading] = useState(!isNew)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [taxAuto, setTaxAuto] = useState(true)
  const [tab, setTab] = useState<'detail' | 'history'>('detail')
  const [revDate, setRevDate] = useState('')
  const [showRev, setShowRev] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const taxCodesRef = useRef(masters.taxCodes)
  taxCodesRef.current = masters.taxCodes

  // 読み込み・保存した時点の内容。これと違えば「未保存の変更あり」
  const baseline = useRef(snapshotOf(blank(), linesOf(blank(), [])))
  const dirty = !loading && snapshotOf(form, items) !== baseline.current
  const { allowNextLeave } = useUnsavedGuard(dirty)

  useEffect(() => {
    if (isNew) {
      baseline.current = snapshotOf(blank(), linesOf(blank(), []))
      setForm(blank())
      setItems(linesOf(blank(), []))
      setHistory([])
      setVersions([])
      setLoading(false)
      return
    }
    setLoading(true)
    ;(async () => {
      try {
        const c = check(await supabase.from('ct_contracts').select('*').eq('id', Number(id)).maybeSingle()) as Contract | null
        if (!c) throw new Error('契約が見つからないか、閲覧権限がありません')
        const [it, al, h, v] = await Promise.all([
          supabase.from('ct_contract_items').select('*').eq('contract_id', c.id).order('sort'),
          supabase.from('ct_contract_allocations').select('*').eq('contract_id', c.id).order('sort'),
          supabase.from('ct_contract_history').select('*').eq('contract_no', c.contract_no).order('changed_at', { ascending: false }),
          supabase.from('ct_contracts').select('*').eq('contract_no', c.contract_no).order('version'),
        ])
        const lines = linesOf(c, check(it) as ContractItem[], check(al) as Allocation[])
        baseline.current = snapshotOf(c, lines)
        setForm(c)
        setItems(lines)
        setHistory(check(h) as HistoryRow[])
        setVersions(check(v) as Contract[])
        const rate = taxCodesRef.current.find((t) => t.name === c.tax_code)?.rate ?? 0
        setTaxAuto(c.amount_excl === null || Math.floor(Number(c.amount_excl) * Number(rate)) === Number(c.tax_amount))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
    // マスタの読み直しで契約を読み込み直すと入力中の内容が上書きされるため、依存は契約の切り替えだけにする
  }, [id, isNew])

  const readOnly = !canEdit || (Boolean(form.accounting_only) && !isAccounting)
  const rate = masters.taxCodes.find((t) => t.name === form.tax_code)?.rate ?? 0

  function upd<K extends keyof Contract>(k: K, v: Contract[K] | null) {
    setForm((f) => {
      const next = { ...f, [k]: v } as Partial<Contract>
      if ((k === 'amount_excl' || k === 'tax_code') && taxAuto) {
        const r = masters.taxCodes.find((t) => t.name === next.tax_code)?.rate ?? 0
        next.tax_amount = next.amount_excl === null || next.amount_excl === undefined ? null : Math.floor(Number(next.amount_excl) * Number(r))
      }
      if (['payment_timing', 'billing_cycle', 'annual_period_note', 'txn_type'].includes(k as string)) {
        const sug = suggestCounter(next)
        const prevSug = suggestCounter(f)
        if (sug && (next.counter_account_code == null || next.counter_account_code === prevSug)) next.counter_account_code = sug
      }
      // 相手科目が変わったら補助科目の既定値（3150→9、1550→1）を入れる
      if (next.counter_account_code !== f.counter_account_code) {
        next.counter_sub_code = nextCounterSub(f.counter_account_code, next.counter_account_code, next.counter_sub_code, s.setting('counter_sub_defaults'))
      }
      if (k === 'vendor_code' && v !== null) {
        const vend = masters.vendors.find((x) => x.code === Number(v))
        if (vend) next.vendor_name = vend.name
      }
      return next
    })
  }

  // 新規：物件を選んだら次の契約IDを採番
  useEffect(() => {
    if (!isNew || !form.property_code) return
    supabase.rpc('ct_next_contract_no', { p_property_code: form.property_code }).then(({ data }) => {
      if (data) setForm((f) => ({ ...f, contract_no: Number(data) }))
    })
    const p = masters.properties.find((x) => x.code === form.property_code)
    if (p?.accounting_only) setForm((f) => ({ ...f, accounting_only: true }))
  }, [isNew, form.property_code, masters.properties])

  const isCycle = form.billing_cycle === '年次' || form.billing_cycle === '半年'
  const isVariable = form.amount_basis === '従量' || form.amount_basis === '手入力'
  // 契約金額 ＝ 内訳の合計。損益科目は金額が一番大きい行の科目（一覧・計上対象の判定用）
  const lineTotal = items.some((x) => x.amount_excl != null) ? items.reduce((a, b) => a + Number(b.amount_excl ?? 0), 0) : null
  const mainLine = [...items].sort((a, b) => Number(b.amount_excl ?? 0) - Number(a.amount_excl ?? 0))[0]
  useEffect(() => {
    if (loading) return
    setForm((f) => {
      if (f.amount_excl === lineTotal && f.pl_account_code === (mainLine?.pl_account_code ?? null) && f.pl_sub_code === (mainLine?.pl_sub_code ?? null)) return f
      const next = { ...f, amount_excl: lineTotal, pl_account_code: mainLine?.pl_account_code ?? null, pl_sub_code: mainLine?.pl_sub_code ?? null }
      if (taxAuto) next.tax_amount = lineTotal == null ? null : Math.floor(lineTotal * Number(masters.taxCodes.find((t) => t.name === f.tax_code)?.rate ?? 0))
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineTotal, mainLine?.pl_account_code, mainLine?.pl_sub_code, loading])
  const lineIssue =
    items.some((x) => x.pl_account_code == null) ? '金額の内訳に損益科目が入っていない行があります'
    : items.length > 1 && items.some((x) => !Number(x.amount_excl ?? 0)) ? '金額の内訳に金額が入っていない行があります（複数行のときは各行の金額が必要です）'
    : null
  const setLine = (i: number, patch: Partial<ContractItem>) => setItems((xs) => xs.map((y, j) => (j === i ? { ...y, ...patch } : y)))
  // 年払いの前払い・後払いは相手科目で決まる（前払い＝前払費用 1550、後払い＝未払費用 3150）
  const prepaid = masters.accounts.find((a) => a.code === form.counter_account_code)?.normal_side !== '貸方'
  const cancelled = Boolean(form.cancel_date)

  // 源泉税の2行目を作れる契約（DB の ct_withholding_of と同じ条件）
  const withholdingOk = form.txn_type === '費用' && form.billing_cycle === '月次'
    && masters.accounts.find((a) => a.code === form.counter_account_code)?.normal_side === '貸方'
  // 自動更新中は「今期の終了日（次回更新日）」を基準にする
  const term = termInfo({
    cancel_date: form.cancel_date ?? null, service_start: form.service_start ?? null,
    service_end: form.service_end ?? null, renewal_type: form.renewal_type ?? null, renewal_term_months: form.renewal_term_months ?? null,
  })
  const termEnd = term.kind === 'active' || term.kind === 'auto' ? term.date : null
  const noticeDeadline = termEnd && form.notice_months != null
    ? `${dateJa(subtractMonths(termEnd, form.notice_months))}（${term.kind === 'auto' ? '今期の終了日' : '終了日'} ${dateJa(termEnd)} の${form.notice_months}か月前）`
    : null
  // 契約期間の状況（1行表示）
  const termStatus =
    term.kind === 'auto' ? `自動更新中　今期の終了日 ${dateJa(term.date)}（元の終了日 ${dateJa(term.originalEnd)}・${term.termMonths}か月ごと・${TERM_SOURCE_LABEL[term.termSource!]}）`
    : term.kind === 'active' ? `期間内（終了日 ${dateJa(term.date)}）`
    : term.kind === 'expired' ? `期限切れ　${dateJa(term.date)} で終了（自動更新ではありません。更新か解約の登録が必要です）`
    : term.kind === 'cancel' ? (term.date! >= todayIso() ? `解約予定　${dateJa(term.date)} まで計上` : `解約済　${dateJa(term.date)} で終了`)
    : form.status === '申請中' ? '申請中（終了日が未入力）' : form.status === '停止' ? '停止中' : '期間の定めなし（終了日が未入力）'
  const [whOpen, setWhOpen] = useState(false)

  // 毎月できる仕訳のプレビュー（月次計上と同じ考え方の概算）
  const preview = useMemo(() => {
    const acc = (code: number | null | undefined) => (code == null ? '（未設定）' : `${code} ${s.accountName(code)}`)
    const counter = acc(form.counter_account_code)
    const n = form.billing_cycle === '半年' ? 6 : isCycle ? 12 : 1
    const total = Number(lineTotal ?? 0)
    const tax = Number(form.tax_amount ?? 0)
    const liability = !prepaid
    const rows: { kind: string; dr: string; cr: string; amount: number | null }[] = []
    for (const x of items) {
      const ex = isVariable ? null : Math.floor(Number(x.amount_excl ?? 0) / n)
      const lt = total ? Math.floor((tax * Number(x.amount_excl ?? 0)) / total / n) : 0
      const where = items.length > 1 ? `（${s.propertyName(x.property_code ?? form.property_code)}${x.item_name ? '・' + x.item_name : ''}）` : ''
      rows.push({ kind: '計上', dr: `${acc(x.pl_account_code)}${where}`, cr: counter, amount: ex == null ? null : ex + (liability ? lt : 0) })
    }
    const wh = withholdingOk ? Number(form.withholding_amount ?? 0) : 0
    if (wh > 0) rows.push({ kind: '源泉税', dr: counter, cr: `${s.setting('withholding_account') || 3180} 預り金（補助${s.setting('withholding_sub_code') || 1}）`, amount: wh })
    rows.push({ kind: isCycle ? '支払（支払月）' : '支払', dr: counter, cr: `${s.setting('cash_account') || 1120} 普通預金`, amount: isVariable ? null : total + tax - wh })
    const note = !(form.is_active ?? true) ? '「毎月計上する」がオフのため、月次計上では仕訳を作りません。'
      : isCycle ? (prepaid ? '前払い：支払月に1期間分を前払費用にし、毎月その月割を費用にします。' : '後払い：毎月その月割を費用と未払費用に計上し、支払月にまとめて払います。')
      : '計上は毎月末（または月初）、支払は支払のタイミングの月です。CSV には支払の行は出ません。'
    return { rows, note }
  }, [items, form, lineTotal, isCycle, isVariable, prepaid, withholdingOk, s])
  const issues = useMemo(() => {
    const out: string[] = []
    if ((form.status === '解約予定' || form.status === '解約済') && !form.cancel_date) out.push('解約日を入力してください')
    if (form.amount_excl == null && !isVariable) out.push('金額が未入力です')
    if (!form.counter_account_code) out.push('相手科目が未入力です')
    if (isCycle && !form.annual_payment_month) out.push('年払いの支払月を選んでください')
    if (isCycle && !form.annual_start_month) out.push('年払いの対象開始月を選んでください')
    if (isCycle && !['年額', '一括'].includes(form.amount_basis ?? '')) out.push('年次・半年契約は金額基準を「年額」または「一括」にしてください')
    if (form.billing_cycle === '月次' && form.is_active && !PAYMENT_TIMINGS.includes(form.payment_timing ?? ''))
      out.push('支払区分（当月分の支払月）が未設定のため、支払仕訳が作られません')
    if (Number(form.withholding_amount) > 0 && !withholdingOk)
      out.push('源泉徴収税額は、月次・費用で相手科目が未払金・未払費用の契約だけ仕訳に反映されます')
    if (lineIssue) out.push(lineIssue)
    return out
  }, [form, withholdingOk, lineIssue, isVariable, isCycle])

  async function save() {
    setError(null)
    setSaved(null)
    if (!form.property_code || !form.contract_name || !form.contract_no) {
      setError('物件・契約ID・契約名は必須です')
      return
    }
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {}
      EDITABLE_KEYS.forEach((k) => {
        const v = form[k]
        payload[k] = v === '' || v === undefined ? null : v
      })
      payload.is_active = form.is_active ?? true
      payload.accounting_only = form.accounting_only ?? false
      // 解約予定・解約済は解約日から自動で決める（解約日が今日以降なら解約予定）
      payload.status = form.cancel_date
        ? (form.cancel_date >= todayIso() ? '解約予定' : '解約済')
        : (form.status === '解約予定' || form.status === '解約済' ? '契約中' : form.status ?? '契約中')
      payload.txn_type = form.txn_type ?? '費用'
      payload.version = form.version ?? 1

      if (form.vendor_code && !masters.vendors.some((v) => v.code === form.vendor_code) && form.vendor_name) {
        await supabase.from('ct_vendors').insert({ code: form.vendor_code, name: form.vendor_name })
      }

      let cid = form.id
      if (isNew) {
        const row = check(await supabase.from('ct_contracts').insert(payload).select('id').single()) as { id: number }
        cid = row.id
      } else {
        check(await supabase.from('ct_contracts').update(payload).eq('id', form.id!))
      }
      // 金額の内訳は全件置き換え。契約の物件・科目の1行だけなら明細は持たない（契約の項目で足りる）
      check(await supabase.from('ct_contract_allocations').delete().eq('contract_id', cid!))
      check(await supabase.from('ct_contract_items').delete().eq('contract_id', cid!))
      const single = items.length === 1 && (items[0].property_code ?? form.property_code) === form.property_code
      if (!single)
        check(await supabase.from('ct_contract_items').insert(
          items.map((x, i) => ({
            contract_id: cid, item_name: x.item_name || `明細${i + 1}`, amount_excl: x.amount_excl, note: x.note, sort: i,
            pl_account_code: x.pl_account_code ?? null, pl_sub_code: x.pl_sub_code || null, property_code: x.property_code ?? form.property_code,
          })),
        ))
      const savedForm = { ...form, status: payload.status as string }
      setForm(savedForm)
      baseline.current = snapshotOf(savedForm, items)
      setSaved('保存しました')
      if (isNew) {
        allowNextLeave()
        nav(`/contracts/${cid}`, { replace: true })
      }
      else {
        const h = await supabase.from('ct_contract_history').select('*').eq('contract_no', form.contract_no!).order('changed_at', { ascending: false })
        setHistory((h.data as HistoryRow[]) ?? [])
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function createRevision() {
    if (!revDate) {
      setError('改定後の開始日を入力してください')
      return
    }
    setBusy(true)
    setError(null)
    const { data, error } = await supabase.rpc('ct_create_revision', { p_contract_id: form.id, p_new_start: revDate })
    setBusy(false)
    if (error) setError(error.message)
    else {
      setShowRev(false)
      nav(`/contracts/${data}`)
    }
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('ct_contracts').delete().eq('id', form.id!)
    setBusy(false)
    if (error) setError(error.message.includes('foreign key') ? 'この契約には仕訳があるため削除できません。「無効」にしてください。' : error.message)
    else {
      allowNextLeave()
      nav('/contracts')
    }
  }

  if (loading) return <Loading />

  const title = isNew ? '契約の新規登録' : `${form.contract_no}-${form.version}　${form.contract_name ?? ''}`
  const accounts = masters.accounts
  const latestVersion = versions.length ? Math.max(...versions.map((v) => v.version)) : form.version

  return (
    <>
      <PageHeader
        title={title}
        sub={
          !isNew && (
            <>
              <Badge tone={judgementTone(form.status ?? '')}>{form.status}</Badge> {form.is_active ? '' : <Badge tone="muted">計上しない</Badge>}{' '}
              {s.propertyName(form.property_code)}／{form.vendor_name}
              {form.accounting_only && <span className="tag tag-lock">総務経理部のみ閲覧</span>}
            </>
          )
        }
        actions={
          <>
            <Link className="button" to="/contracts">一覧へ</Link>
            {!isNew && !readOnly && form.version === latestVersion && (
              <button onClick={() => setShowRev((v) => !v)}>改定（新しい枝番）</button>
            )}
            {!readOnly && dirty && <span className="unsaved-badge">未保存の変更あり</span>}
            {!readOnly && (
              <button className="primary" onClick={save} disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
            )}
          </>
        }
      />
      <ErrorBox error={error} />
      {saved && <Notice tone="ok">{saved}</Notice>}
      {readOnly && <Notice>閲覧のみです（編集権限がありません）。</Notice>}
      {showRev && (
        <div className="card inline-form">
          <p>
            金額・条件の変更など、<b>新しい条件の適用開始日</b>を指定して新しい枝番（{form.contract_no}-{(latestVersion ?? 1) + 1}）を作成します。
            現在の枝番は開始日の前日付で「解約済」になり、月次計上は自動で切り替わります。
          </p>
          <div className="row">
            <Field label="改定後の開始日">
              <DateInput value={revDate || null} onChange={(v) => setRevDate(v ?? '')} />
            </Field>
            <button className="primary" onClick={createRevision} disabled={busy}>枝番を作成して編集</button>
            <button onClick={() => setShowRev(false)}>やめる</button>
          </div>
        </div>
      )}
      {versions.length > 1 && (
        <div className="versions">
          枝番：
          {versions.map((v) => (
            <Link key={v.id} to={`/contracts/${v.id}`} className={v.id === form.id ? 'current' : ''}>
              -{v.version}（{dateJa(v.service_start) || '開始日未設定'}〜{dateJa(v.cancel_date ?? v.service_end)}・{yen(v.amount_excl)}円）
            </Link>
          ))}
        </div>
      )}
      {issues.length > 0 && (
        <div className="alert alert-warn">
          <b>月次計上の前に確認：</b>
          {issues.join('／')}
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'detail' ? 'on' : ''} onClick={() => setTab('detail')}>契約内容</button>
        {!isNew && <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>変更履歴（{history.length}）</button>}
      </div>

      {tab === 'detail' && (
        <fieldset disabled={readOnly} className="plain">
          {/* ---------- 基本 ---------- */}
          <section className="card">
            <h2>基本</h2>
            <div className="grid">
              <Field label="物件" required>
                <Select
                  value={form.property_code}
                  onChange={(v) => {
                    const code = v ? Number(v) : null
                    // 内訳の物件が契約の物件と同じ行は一緒に変える
                    setItems((xs) => xs.map((x) => (x.property_code == null || x.property_code === form.property_code ? { ...x, property_code: code } : x)))
                    upd('property_code', code)
                  }}
                  options={masters.properties.filter((p) => p.is_active || p.code === form.property_code).map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }))}
                  disabled={!isNew}
                />
              </Field>
              <Field label="契約ID" required hint={isNew ? '物件を選ぶと自動採番されます' : `枝番 ${form.version ?? 1}`}>
                <input className="mono" value={form.contract_no ?? ''} onChange={(e) => upd('contract_no', e.target.value ? Number(e.target.value) : null)} disabled={!isNew} />
              </Field>
              <Field label="契約名" wide required>
                <input value={form.contract_name ?? ''} onChange={(e) => upd('contract_name', e.target.value)} />
              </Field>
              <Field label="取引先コード">
                <input className="mono" list="vendor-codes" value={form.vendor_code ?? ''} onChange={(e) => upd('vendor_code', e.target.value ? Number(e.target.value) : null)} />
                <datalist id="vendor-codes">
                  {masters.vendors.map((v) => <option key={v.code} value={v.code}>{v.name}</option>)}
                </datalist>
              </Field>
              <Field label="取引先名" wide>
                <input
                  list="vendor-names"
                  value={form.vendor_name ?? ''}
                  onChange={(e) => {
                    const name = e.target.value
                    const vend = masters.vendors.find((v) => v.name === name)
                    setForm((f) => ({ ...f, vendor_name: name, vendor_code: vend ? vend.code : f.vendor_code }))
                  }}
                />
                <datalist id="vendor-names">
                  {masters.vendors.map((v) => <option key={v.code} value={v.name} />)}
                </datalist>
              </Field>
              <Field label="契約担当部門">
                <Select value={form.department} onChange={(v) => upd('department', v || null)} options={options('department')} />
              </Field>
              <Field label="契約担当者">
                <input value={form.person_in_charge ?? ''} onChange={(e) => upd('person_in_charge', e.target.value)} />
              </Field>
              <Field label="総務経理部のみ閲覧">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(form.accounting_only)}
                    onChange={(e) => upd('accounting_only', e.target.checked)}
                    disabled={!isAccounting || Boolean(masters.properties.find((p) => p.code === form.property_code)?.accounting_only)}
                  />
                  管理部には表示しない
                </label>
              </Field>
              <Field label="備考" wide>
                <textarea rows={2} value={form.trade_note ?? ''} onChange={(e) => upd('trade_note', e.target.value || null)}
                  placeholder="取引先・管理に関するメモ（担当窓口、連絡先、引継ぎ事項など）" />
              </Field>
            </div>
          </section>

          {/* ---------- 契約期間・更新 ---------- */}
          <section className="card">
            <div className="card-head">
              <h2>契約期間・更新</h2>
              {!isNew && !readOnly && (
                cancelled
                  ? <button type="button" onClick={() => setForm((f) => ({ ...f, cancel_date: null }))}>解約を取り消す</button>
                  : <button type="button" onClick={() => setCancelDraft({ date: termEnd ?? form.service_end ?? null, memo: '' })}>解約する</button>
              )}
            </div>
            <div className={`term-status term-${term.kind}`}>{termStatus}</div>
            {cancelDraft && (
              <div className="inline-dialog">
                <h3>契約を解約する</h3>
                <p className="muted small">解約日の月まで計上し、翌月から止めます。状態は日付から自動で決まります（今日以降なら解約予定、過去なら解約済）。保存すると反映されます。</p>
                <div className="grid">
                  <Field label="解約日" required><DateInput value={cancelDraft.date} onChange={(v) => setCancelDraft((d) => d && { ...d, date: v })} /></Field>
                  <Field label="理由・メモ（任意）" wide><input value={cancelDraft.memo} onChange={(e) => setCancelDraft((d) => d && { ...d, memo: e.target.value })} placeholder="管理会社の変更のため" /></Field>
                </div>
                {!cancelDraft.date && <p className="danger-text small">解約日を入力してください</p>}
                <div className="row">
                  <button type="button" className="danger" disabled={!cancelDraft.date}
                    onClick={() => {
                      const d = cancelDraft
                      setForm((f) => ({ ...f, cancel_date: d.date, note2: d.memo ? [f.note2, `解約理由：${d.memo}`].filter(Boolean).join('／') : f.note2 }))
                      setCancelDraft(null)
                    }}>解約日を設定</button>
                  <button type="button" onClick={() => setCancelDraft(null)}>やめる</button>
                </div>
              </div>
            )}
            <div className="grid">
              <Field label="契約締結日"><DateInput value={form.signed_date} onChange={(v) => upd('signed_date', v)} /></Field>
              <Field label="サービス開始日"><DateInput value={form.service_start} onChange={(v) => upd('service_start', v)} /></Field>
              <Field label="サービス終了日"><DateInput value={form.service_end} onChange={(v) => upd('service_end', v)} /></Field>
              {cancelled && <Field label="解約日" hint="変えるときは日付を直して保存"><DateInput value={form.cancel_date} onChange={(v) => upd('cancel_date', v)} /></Field>}
              <Field label="更新区分">
                <Select value={form.renewal_type} onChange={(v) => upd('renewal_type', v || null)} options={options('renewal_type')} />
              </Field>
              {!cancelled && form.status !== '解約済' && (
                <Field label="契約状態" hint="解約は「解約する」ボタンから">
                  <Select value={form.status} onChange={(v) => upd('status', v || '契約中')} options={['申請中', '契約中', '停止']} placeholder="契約中" />
                </Field>
              )}
            </div>
            {form.renewal_type === '自動更新' && !cancelled && (
              <div className="grid sub-grid">
                <Field label="更新期間（何か月ごと）" hint="空欄なら開始日〜終了日の長さ、それも無ければ12か月">
                  <input type="number" min={1} max={120} value={form.renewal_term_months ?? ''}
                    placeholder={term.kind === 'auto' && term.termSource !== 'input' ? String(term.termMonths) : '12'}
                    onChange={(e) => upd('renewal_term_months', e.target.value ? Number(e.target.value) : null)} />
                </Field>
                <Field label="解約通知（何か月前）" hint={noticeDeadline ? `次の解約通知期限：${noticeDeadline}` : '終了日と合わせて入れると期限を自動計算'}>
                  <input type="number" min={0} max={36} value={form.notice_months ?? ''} onChange={(e) => upd('notice_months', e.target.value ? Number(e.target.value) : null)} />
                </Field>
                <Field label="解約通知の方法・条件" wide>
                  <input value={form.renewal_notice ?? ''} onChange={(e) => upd('renewal_notice', e.target.value || null)} placeholder="例：書面で通知／更新の1か月前までに申し出" />
                </Field>
              </div>
            )}
          </section>

          {/* ---------- 金額・支払 ---------- */}
          <section className="card">
            <h2>金額・支払</h2>
            <div className="grid">
              <Field label="請求サイクル">
                <Select value={form.billing_cycle} onChange={(v) => upd('billing_cycle', v || null)} options={options('billing_cycle')} />
              </Field>
              <Field label="初回請求日"><DateInput value={form.first_billing_date} onChange={(v) => upd('first_billing_date', v)} /></Field>
              <Field label="金額基準" hint="月額・年額＝定額／従量・手入力＝毎月実績を入力">
                <Select value={form.amount_basis} onChange={(v) => upd('amount_basis', v || null)} options={options('amount_basis')} />
              </Field>
              <Field label="税区分">
                <Select value={form.tax_code} onChange={(v) => upd('tax_code', v || null)} options={masters.taxCodes.map((t) => t.name)} />
              </Field>
              <Field label="端数処理" hint="年額の月割は初月で調整、消費税は切捨てで計算します">
                <Select value={form.rounding} onChange={(v) => upd('rounding', v || null)} options={options('rounding')} />
              </Field>
            </div>
            {isCycle && (
              <div className="grid sub-grid">
                <Field label="年払いの払い方" hint={prepaid ? '期間の初めにまとめて払う（前払費用）' : '期間が終わってからまとめて払う（未払費用）'}>
                  <div className="row tight radio-row">
                    <label className="check"><input type="radio" checked={prepaid} onChange={() => upd('counter_account_code', 1550)} /> 前払い</label>
                    <label className="check"><input type="radio" checked={!prepaid} onChange={() => upd('counter_account_code', 3150)} /> 後払い</label>
                  </div>
                </Field>
                <Field label="支払月" hint={form.billing_cycle === '半年' ? 'この月と6か月後に支払います' : undefined}>
                  <Select value={form.annual_payment_month} onChange={(v) => upd('annual_payment_month', v ? Number(v) : null)} options={MONTHS} />
                </Field>
                <Field label="対象期間の開始月" hint="この月に端数を調整します">
                  <Select value={form.annual_start_month} onChange={(v) => upd('annual_start_month', v ? Number(v) : null)} options={MONTHS} />
                </Field>
                <Field label="対象期間メモ" wide>
                  <input value={form.annual_period_note ?? ''} onChange={(e) => upd('annual_period_note', e.target.value)} placeholder="例：当年4月～翌年3月分" />
                </Field>
              </div>
            )}

            <div className="lines-head">
              <span>金額の内訳（税抜{isCycle ? (form.billing_cycle === '半年' ? '・半年分' : '・年額') : ''}）</span>
              <span className="muted small">1行なら今までどおり。行を足すと、物件・科目ごとに計上が分かれます（支払は1本）</span>
            </div>
            <table className="data compact lines-table">
              <thead><tr><th>物件</th><th>項目</th><th className="r">税抜金額</th><th>損益科目</th><th>補助</th><th /></tr></thead>
              <tbody>
                {items.map((x, i) => (
                  <tr key={i}>
                    <td>
                      <Select value={x.property_code ?? form.property_code} onChange={(v) => setLine(i, { property_code: v ? Number(v) : null })}
                        options={masters.properties.filter((p) => p.is_active || p.code === x.property_code).map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }))} />
                    </td>
                    <td><input value={x.item_name} onChange={(e) => setLine(i, { item_name: e.target.value })} placeholder={items.length > 1 ? 'BM・PM など' : '（1行なら空欄で可）'} /></td>
                    <td className="r"><MoneyInput value={x.amount_excl} onChange={(v) => setLine(i, { amount_excl: v })} placeholder={isVariable ? '実績で計上' : undefined} /></td>
                    <td><AccountSelect value={x.pl_account_code ?? null} accounts={accounts} filter={(a) => a.bs_pl !== 'BS' || a.code === 1520}
                      onChange={(v) => setLine(i, { pl_account_code: v })} /></td>
                    <td><input className="narrow" value={x.pl_sub_code ?? ''} onChange={(e) => setLine(i, { pl_sub_code: e.target.value || null })} /></td>
                    <td>{items.length > 1 && <button type="button" className="small" aria-label="この行を削除" onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}>×</button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>契約金額（合計）</td>
                  <td className="r mono"><b>{yen(lineTotal)}</b></td>
                  <td colSpan={3} className="small">
                    消費税
                    <span className="inline-money"><MoneyInput value={form.tax_amount} onChange={(v) => { setTaxAuto(false); upd('tax_amount', v) }} /></span>
                    {taxAuto ? <span className="muted">（自動・{Number(rate) * 100}%切捨て）</span> : (
                      <button type="button" className="small" onClick={() => { setTaxAuto(true); setForm((f) => ({ ...f, tax_amount: lineTotal == null ? null : Math.floor(lineTotal * Number(rate)) })) }}>自動に戻す</button>
                    )}
                    　税込 <b>{yen(lineTotal == null ? null : lineTotal + Number(form.tax_amount ?? 0))}</b>
                  </td>
                </tr>
              </tfoot>
            </table>
            {!isVariable && (
              <button type="button" onClick={() => setItems((xs) => [...xs, { item_name: '', amount_excl: null, note: null, sort: xs.length,
                pl_account_code: mainLine?.pl_account_code ?? null, pl_sub_code: null, property_code: form.property_code ?? null }])}>＋ 物件・科目を追加</button>
            )}

            <div className="grid sub-grid">
              {!isCycle && (
                <Field label="支払のタイミング" hint="未払費用・前払費用の残高計算に使います">
                  <Select value={form.payment_timing} onChange={(v) => upd('payment_timing', v || null)} options={options('payment_timing')} />
                </Field>
              )}
              <Field label="支払方法">
                <Select value={form.payment_method} onChange={(v) => upd('payment_method', v || null)} options={withCurrent(options('payment_method'), form.payment_method)} />
              </Field>
            </div>
            {(withholdingOk || Number(form.withholding_amount) > 0) && (
              <div className="sub-grid">
                <label className="check">
                  <input type="checkbox" checked={Number(form.withholding_amount) > 0 || whOpen}
                    onChange={(e) => { setWhOpen(e.target.checked); upd('withholding_amount', e.target.checked ? withholdingTax(Number(lineTotal ?? 0)) : null) }} />
                  源泉徴収あり（顧問料・報酬など）
                </label>
                {(Number(form.withholding_amount) > 0 || whOpen) && (
                  <div className="grid">
                    <Field label="源泉徴収税額（月額）" hint="税抜 × 10.21%（100万円を超える部分は 20.42%）">
                      <div className="row tight">
                        <MoneyInput value={form.withholding_amount} onChange={(v) => upd('withholding_amount', v)} />
                        <button type="button" className="small" onClick={() => upd('withholding_amount', withholdingTax(Number(lineTotal ?? 0)))}>計算</button>
                      </div>
                    </Field>
                    <Field label="振込額（自動）">
                      <input className="num" disabled value={yen(Number(lineTotal ?? 0) + Number(form.tax_amount ?? 0) - Number(form.withholding_amount ?? 0))} />
                    </Field>
                  </div>
                )}
              </div>
            )}
            <Field label="備考（請求・金額）" wide>
              <input value={form.note ?? ''} onChange={(e) => upd('note', e.target.value)} />
            </Field>
          </section>

          {/* ---------- 会計 ---------- */}
          <section className="card">
            <div className="card-head">
              <h2>会計 <span className="muted small">（自動で決まります。変えるときだけ触ってください）</span></h2>
              <label className="check"><input type="checkbox" checked={form.is_active ?? true} onChange={(e) => upd('is_active', e.target.checked)} /> 毎月計上する</label>
            </div>
            <div className="grid">
              <Field label="相手科目（経過勘定）" hint={isCycle ? '年払いの前払い・後払いで決まります' : '支払のタイミングで決まります'}>
                <AccountSelect value={form.counter_account_code ?? null} onChange={(v) => upd('counter_account_code', v)} accounts={accounts} filter={(a) => a.is_accrual} />
              </Field>
              <Field label="相手 補助科目">
                <input value={form.counter_sub_code ?? ''} onChange={(e) => upd('counter_sub_code', e.target.value)} />
              </Field>
              <Field label="仕訳日ルール">
                <Select value={form.journal_date_rule} onChange={(v) => upd('journal_date_rule', v || null)} options={options('journal_date_rule')} />
              </Field>
              <Field label="取引区分">
                <Select value={form.txn_type} onChange={(v) => upd('txn_type', v || '費用')} options={options('txn_type')} />
              </Field>
            </div>
            <div className="lines-head"><span>毎月できる仕訳（プレビュー）</span></div>
            <table className="data compact">
              <thead><tr><th>種類</th><th>借方</th><th>貸方</th><th className="r">金額</th></tr></thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}><td>{r.kind}</td><td>{r.dr}</td><td>{r.cr}</td><td className="r mono">{r.amount == null ? '実績' : yen(r.amount)}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">{preview.note}</p>
          </section>

          {/* ---------- 管理・証憑 ---------- */}
          <details className="card collapsible" open={Boolean(form.ringi_no || form.contract_url || form.note2)}>
            <summary><h2>管理・証憑</h2><span className="muted small">稟議書NO・契約書URL・インボイス区分・備考</span></summary>
            <div className="grid">
              <Field label="稟議書NO"><input value={form.ringi_no ?? ''} onChange={(e) => upd('ringi_no', e.target.value)} /></Field>
              <Field label="契約書URL" wide>
                <div className="row tight">
                  <input value={form.contract_url ?? ''} onChange={(e) => upd('contract_url', e.target.value)} />
                  {form.contract_url && <a className="button small" href={form.contract_url} target="_blank" rel="noreferrer">開く</a>}
                </div>
              </Field>
              <Field label="インボイス区分">
                <Select value={form.invoice_type} onChange={(v) => upd('invoice_type', v || null)} options={options('invoice_type')} />
              </Field>
              <Field label="備考（管理・証憑）" wide><textarea rows={2} value={form.note2 ?? ''} onChange={(e) => upd('note2', e.target.value || null)} /></Field>
            </div>
          </details>
        </fieldset>
      )}

      {tab === 'history' && <History rows={history} />}

      {!isNew && isAccounting && canEdit && tab === 'detail' && (
        <div className="danger-zone">
          {confirmDelete ? (
            <>
              <span>この枝番を削除します。元に戻せません（履歴は残ります）。</span>
              <button className="danger" onClick={remove} disabled={busy}>削除する</button>
              <button onClick={() => setConfirmDelete(false)}>やめる</button>
            </>
          ) : (
            <button className="link danger-text" onClick={() => setConfirmDelete(true)}>この枝番を削除…</button>
          )}
        </div>
      )}
    </>
  )
}

function fmt(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）'
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ'
  if (k.includes('amount')) return yen(Number(v))
  return String(v)
}

function History({ rows }: { rows: HistoryRow[] }) {
  if (!rows.length) return <section className="card"><p className="muted">履歴はまだありません。</p></section>
  return (
    <section className="card">
      <h2>変更履歴（同じ契約IDの全枝番）</h2>
      <ol className="history">
        {rows.map((h) => {
          const changes =
            h.action === 'UPDATE' && h.old_data && h.new_data
              ? Object.keys(FIELD_LABELS).filter((k) => JSON.stringify(h.old_data![k]) !== JSON.stringify(h.new_data![k]))
              : []
          return (
            <li key={h.id}>
              <div className="history-head">
                <span className="mono">{new Date(h.changed_at).toLocaleString('ja-JP')}</span>
                <Badge tone={h.action === 'INSERT' ? 'ok' : h.action === 'DELETE' ? 'bad' : 'info'}>
                  {h.action === 'INSERT' ? '登録' : h.action === 'DELETE' ? '削除' : '変更'}
                </Badge>
                <span>枝番 {h.version}</span>
                <span className="muted">{h.changed_by_name || '（データ移行／システム）'}</span>
              </div>
              {changes.length > 0 && (
                <table className="diff">
                  <tbody>
                    {changes.map((k) => (
                      <tr key={k}>
                        <th>{FIELD_LABELS[k]}</th>
                        <td className="old">{fmt(k, h.old_data![k])}</td>
                        <td>→</td>
                        <td className="new">{fmt(k, h.new_data![k])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
