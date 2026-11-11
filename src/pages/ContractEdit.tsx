import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase, check } from '../lib/supabase'
import { useSession } from '../lib/session'
import type { Allocation, Contract, ContractItem, HistoryRow } from '../lib/types'
import { FIELD_LABELS } from '../lib/types'
import { dateJa, subtractMonths, yen } from '../lib/format'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { PAYMENT_TIMINGS, nextCounterSub, suggestCounter, withholdingTax } from '../lib/contractRules'
import { TERM_SOURCE_LABEL, termInfo } from '../lib/term'
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
const snapshotOf = (f: Partial<Contract>, a: Allocation[], it: ContractItem[]) =>
  JSON.stringify({
    f: EDITABLE_KEYS.filter((k) => k !== 'contract_no' && k !== 'accounting_only').map((k) => blankToNull(f[k])),
    a: a.map((x) => [x.property_code, blankToNull(x.label), Number(x.amount_excl || 0)]),
    it: it.map((x) => [blankToNull(x.item_name), blankToNull(x.amount_excl), blankToNull(x.note), blankToNull(x.pl_account_code), blankToNull(x.pl_sub_code)]),
  })

export default function ContractEdit() {
  const { id } = useParams()
  const isNew = !id
  const nav = useNavigate()
  const s = useSession()
  const { masters, options, canEdit, isAccounting } = s

  const [form, setForm] = useState<Partial<Contract>>(blank())
  const [allocs, setAllocs] = useState<Allocation[]>([])
  const [items, setItems] = useState<ContractItem[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [versions, setVersions] = useState<Contract[]>([])
  const [loading, setLoading] = useState(!isNew)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [taxAuto, setTaxAuto] = useState(true)
  const [tab, setTab] = useState<'detail' | 'alloc' | 'items' | 'history'>('detail')
  const [revDate, setRevDate] = useState('')
  const [showRev, setShowRev] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const taxCodesRef = useRef(masters.taxCodes)
  taxCodesRef.current = masters.taxCodes

  // 読み込み・保存した時点の内容。これと違えば「未保存の変更あり」
  const baseline = useRef(snapshotOf(blank(), [], []))
  const dirty = !loading && snapshotOf(form, allocs, items) !== baseline.current
  const { allowNextLeave } = useUnsavedGuard(dirty)

  useEffect(() => {
    if (isNew) {
      baseline.current = snapshotOf(blank(), [], [])
      setForm(blank())
      setAllocs([])
      setItems([])
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
        const [a, it, h, v] = await Promise.all([
          supabase.from('ct_contract_allocations').select('*').eq('contract_id', c.id).order('sort'),
          supabase.from('ct_contract_items').select('*').eq('contract_id', c.id).order('sort'),
          supabase.from('ct_contract_history').select('*').eq('contract_no', c.contract_no).order('changed_at', { ascending: false }),
          supabase.from('ct_contracts').select('*').eq('contract_no', c.contract_no).order('version'),
        ])
        baseline.current = snapshotOf(c, check(a) as Allocation[], check(it) as ContractItem[])
        setForm(c)
        setAllocs(check(a) as Allocation[])
        setItems(check(it) as ContractItem[])
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

  const allocTotal = allocs.reduce((a, b) => a + Number(b.amount_excl || 0), 0)
  const isCycle = form.billing_cycle === '年次' || form.billing_cycle === '半年'
  // 科目明細（科目のある内訳行）。DB の仕訳生成と同じく、金額のある行だけを割合に使う
  const accountLines = items.filter((x) => x.pl_account_code != null && Number(x.amount_excl ?? 0) !== 0)
  const lineSum = accountLines.length ? accountLines.reduce((a, b) => a + Number(b.amount_excl ?? 0), 0) : null
  const lineIssue =
    lineSum == null ? null
    : items.some((x) => x.pl_account_code != null && !Number(x.amount_excl ?? 0)) ? '科目を入れた行に金額がありません（金額のない行は計上に使いません）'
    : form.amount_excl != null && lineSum !== Number(form.amount_excl)
      ? `科目明細の合計（${yen(lineSum)}）が税抜契約金額（${yen(Number(form.amount_excl))}）と一致していません（割合として使います）`
      : null

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
  const termNote =
    term.kind === 'auto' ? `${dateJa(term.date)}（元の終了日 ${dateJa(term.originalEnd)} から ${term.termMonths}か月ごとに自動更新・${TERM_SOURCE_LABEL[term.termSource!]}）`
    : term.kind === 'active' ? `${dateJa(term.date)}（期間内）`
    : term.kind === 'expired' ? `${dateJa(term.date)} で終了済み（自動更新ではないため、更新・解約の状況を確認してください）`
    : term.kind === 'cancel' ? `解約日 ${dateJa(term.date)}`
    : 'サービス終了日を入れると表示します'
  const issues = useMemo(() => {
    const out: string[] = []
    if ((form.status === '解約予定' || form.status === '解約済') && !form.cancel_date) out.push('解約日を入力してください')
    if (form.amount_excl == null && !['従量', '手入力'].includes(form.amount_basis ?? '')) out.push('金額が未入力です')
    if (!form.pl_account_code) out.push('損益科目が未入力です')
    if (!form.counter_account_code) out.push('相手科目が未入力です')
    if (isCycle && !form.annual_payment_month) out.push('年払いの支払月を選んでください')
    if (isCycle && !form.annual_start_month) out.push('年払いの対象開始月を選んでください')
    if (isCycle && !['年額', '一括'].includes(form.amount_basis ?? '')) out.push('年次・半年契約は金額基準を「年額」または「一括」にしてください')
    if (form.billing_cycle === '月次' && form.is_active && !PAYMENT_TIMINGS.includes(form.payment_timing ?? ''))
      out.push('支払区分（当月分の支払月）が未設定のため、支払仕訳が作られません')
    if (Number(form.withholding_amount) > 0 && !withholdingOk)
      out.push('源泉徴収税額は、月次・費用で相手科目が未払金・未払費用の契約だけ仕訳に反映されます')
    if (lineIssue) out.push(lineIssue)
    if (allocs.length > 0 && form.amount_excl != null && allocTotal !== Number(form.amount_excl))
      out.push(`按分合計（${yen(allocTotal)}）が税抜契約金額と一致していません（按分比率として使います）`)
    return out
  }, [form, allocs, allocTotal, withholdingOk, lineIssue])

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
      payload.status = form.status ?? '契約中'
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
      // 按分・内訳は全件置き換え
      check(await supabase.from('ct_contract_allocations').delete().eq('contract_id', cid!))
      if (allocs.length)
        check(await supabase.from('ct_contract_allocations').insert(
          allocs.map((a, i) => ({ contract_id: cid, property_code: a.property_code, label: a.label, amount_excl: a.amount_excl || 0, sort: i })),
        ))
      check(await supabase.from('ct_contract_items').delete().eq('contract_id', cid!))
      if (items.length)
        check(await supabase.from('ct_contract_items').insert(
          items.filter((x) => x.item_name).map((x, i) => ({
            contract_id: cid, item_name: x.item_name, amount_excl: x.amount_excl, note: x.note, sort: i,
            pl_account_code: x.pl_account_code ?? null, pl_sub_code: x.pl_sub_code || null,
          })),
        ))
      baseline.current = snapshotOf(form, allocs, items)
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
              <Badge tone={judgementTone(form.status ?? '')}>{form.status}</Badge> {form.is_active ? '' : <Badge tone="muted">無効</Badge>}{' '}
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
        <button className={tab === 'alloc' ? 'on' : ''} onClick={() => setTab('alloc')}>按分{allocs.length ? `（${allocs.length}）` : ''}</button>
        <button className={tab === 'items' ? 'on' : ''} onClick={() => setTab('items')}>{accountLines.length ? '内訳・科目明細' : '内訳'}{items.length ? `（${items.length}）` : ''}</button>
        {!isNew && <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>変更履歴（{history.length}）</button>}
      </div>

      {tab === 'detail' && (
        <fieldset disabled={readOnly} className="plain">
          <section className="card">
            <h2>識別・状態</h2>
            <div className="grid">
              <Field label="物件" required>
                <Select
                  value={form.property_code}
                  onChange={(v) => upd('property_code', v ? Number(v) : null)}
                  options={masters.properties.filter((p) => p.is_active || p.code === form.property_code).map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }))}
                  disabled={!isNew}
                />
              </Field>
              <Field label="契約ID" required hint={isNew ? '物件を選ぶと自動採番されます' : undefined}>
                <input className="mono" value={form.contract_no ?? ''} onChange={(e) => upd('contract_no', e.target.value ? Number(e.target.value) : null)} disabled={!isNew} />
              </Field>
              <Field label="枝番">
                <input value={form.version ?? 1} disabled />
              </Field>
              <Field label="有効フラグ">
                <Select value={form.is_active ? '有効' : '無効'} onChange={(v) => upd('is_active', v !== '無効')} options={['有効', '無効']} placeholder="有効" />
              </Field>
              <Field label="契約状態">
                <Select value={form.status} onChange={(v) => upd('status', v || '契約中')} options={options('status')} />
              </Field>
              <Field label="取引区分">
                <Select value={form.txn_type} onChange={(v) => upd('txn_type', v || '費用')} options={options('txn_type')} />
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
            </div>
          </section>

          <section className="card">
            <h2>取引・管理</h2>
            <div className="grid">
              <Field label="取引先コード">
                <input className="mono" list="vendor-codes" value={form.vendor_code ?? ''} onChange={(e) => upd('vendor_code', e.target.value ? Number(e.target.value) : null)} />
                <datalist id="vendor-codes">
                  {masters.vendors.map((v) => (
                    <option key={v.code} value={v.code}>{v.name}</option>
                  ))}
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
                  {masters.vendors.map((v) => (
                    <option key={v.code} value={v.name} />
                  ))}
                </datalist>
              </Field>
              <Field label="契約名" wide required>
                <input value={form.contract_name ?? ''} onChange={(e) => upd('contract_name', e.target.value)} />
              </Field>
              <Field label="契約担当部門">
                <Select value={form.department} onChange={(v) => upd('department', v || null)} options={options('department')} />
              </Field>
              <Field label="契約担当者">
                <input value={form.person_in_charge ?? ''} onChange={(e) => upd('person_in_charge', e.target.value)} />
              </Field>
              <Field label="備考" wide>
                <textarea rows={2} value={form.trade_note ?? ''} onChange={(e) => upd('trade_note', e.target.value || null)}
                  placeholder="取引先・管理に関するメモ（担当窓口、連絡先、引継ぎ事項など）" />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2>契約期間・更新</h2>
            <div className="grid">
              <Field label="契約締結日"><DateInput value={form.signed_date} onChange={(v) => upd('signed_date', v)} /></Field>
              <Field label="サービス開始日"><DateInput value={form.service_start} onChange={(v) => upd('service_start', v)} /></Field>
              <Field label="サービス終了日"><DateInput value={form.service_end} onChange={(v) => upd('service_end', v)} /></Field>
              <Field label="解約日" hint="解約予定・解約済の場合は必須"><DateInput value={form.cancel_date} onChange={(v) => upd('cancel_date', v)} /></Field>
              <Field label="更新区分">
                <Select value={form.renewal_type} onChange={(v) => upd('renewal_type', v || null)} options={options('renewal_type')} />
              </Field>
              {form.renewal_type === '自動更新' && (
                <Field label="更新期間（何か月ごと）" hint="空欄なら開始日〜終了日の長さ、それも無ければ12か月">
                  <input type="number" min={1} max={120} value={form.renewal_term_months ?? ''}
                    placeholder={term.kind === 'auto' && term.termSource !== 'input' ? String(term.termMonths) : '12'}
                    onChange={(e) => upd('renewal_term_months', e.target.value ? Number(e.target.value) : null)} />
                </Field>
              )}
              <Field label="今期の終了日（自動計算）" wide>
                <span className={`field-note${term.kind === 'expired' ? ' danger-text' : ''}`}>{termNote}</span>
              </Field>
              <Field label="解約通知（何か月前）" hint="期限日を自動計算し、ダッシュボードで通知します">
                <input type="number" min={0} max={36} value={form.notice_months ?? ''} onChange={(e) => upd('notice_months', e.target.value ? Number(e.target.value) : null)} />
              </Field>
              <Field label="解約通知期限（自動計算）">
                <span className="field-note">{noticeDeadline ?? '終了日と「何か月前」を入れると表示します'}</span>
              </Field>
              <Field label="解約通知の方法・条件" wide hint="期限は上の「何か月前」で管理します。ここには通知の方法や条件だけを書きます">
                <input value={form.renewal_notice ?? ''} onChange={(e) => upd('renewal_notice', e.target.value || null)} placeholder="例：書面で通知／更新の1か月前までに申し出" />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2>請求・金額・税</h2>
            <div className="grid">
              <Field label="請求サイクル">
                <Select value={form.billing_cycle} onChange={(v) => upd('billing_cycle', v || null)} options={options('billing_cycle')} />
              </Field>
              <Field label="当月分 支払月" hint="未払費用／前払費用の残高計算に使います">
                <Select value={form.payment_timing} onChange={(v) => upd('payment_timing', v || null)} options={options('payment_timing')} />
              </Field>
              <Field label="支払方法" hint="選択肢はマスタ →「選択肢」の支払方法で追加できます">
                <Select value={form.payment_method} onChange={(v) => upd('payment_method', v || null)}
                  options={withCurrent(options('payment_method'), form.payment_method)} />
              </Field>
              <Field label="金額基準" hint="月額・年額＝定額／従量・手入力＝変動（毎月実績入力）">
                <Select value={form.amount_basis} onChange={(v) => upd('amount_basis', v || null)} options={options('amount_basis')} />
              </Field>
              <Field label="初回請求日"><DateInput value={form.first_billing_date} onChange={(v) => upd('first_billing_date', v)} /></Field>
              {isCycle && (
                <>
                  <Field label="年払い 支払月" hint={form.billing_cycle === '半年' ? 'この月と6か月後に支払います' : undefined}>
                    <Select value={form.annual_payment_month} onChange={(v) => upd('annual_payment_month', v ? Number(v) : null)} options={MONTHS} />
                  </Field>
                  <Field label="年払い 対象開始月" hint="この月に端数を調整します">
                    <Select value={form.annual_start_month} onChange={(v) => upd('annual_start_month', v ? Number(v) : null)} options={MONTHS} />
                  </Field>
                  <Field label="年払い 対象期間メモ" wide>
                    <input value={form.annual_period_note ?? ''} onChange={(e) => upd('annual_period_note', e.target.value)} placeholder="例：当年4月～翌年3月分（「前年」を含むと後払い扱い）" />
                  </Field>
                </>
              )}
              <Field label="税区分">
                <Select value={form.tax_code} onChange={(v) => upd('tax_code', v || null)} options={masters.taxCodes.map((t) => t.name)} />
              </Field>
              <Field label={isCycle && form.billing_cycle === '半年' ? '税抜契約金額（半年分）' : form.amount_basis === '年額' ? '税抜契約金額（年額）' : '税抜契約金額'}>
                <MoneyInput value={form.amount_excl} onChange={(v) => upd('amount_excl', v)} />
              </Field>
              <Field label="消費税" hint={taxAuto ? `自動計算（${Number(rate) * 100}%・切捨て）` : '手入力'}>
                <div className="row tight">
                  <MoneyInput value={form.tax_amount} onChange={(v) => { setTaxAuto(false); upd('tax_amount', v) }} />
                  {!taxAuto && (
                    <button type="button" className="small" onClick={() => { setTaxAuto(true); setForm((f) => ({ ...f, tax_amount: f.amount_excl == null ? null : Math.floor(Number(f.amount_excl) * Number(rate)) })) }}>
                      自動
                    </button>
                  )}
                </div>
              </Field>
              <Field label="税込契約金額">
                <input className="num" value={form.amount_excl == null ? '' : yen(Number(form.amount_excl) + Number(form.tax_amount ?? 0))} disabled />
              </Field>
              <Field label="源泉徴収税額（月額）"
                hint={withholdingOk
                  ? (form.withholding_amount ? `毎月「相手科目／預り金」の仕訳を作り、支払は ${yen(Number(form.amount_excl ?? 0) + Number(form.tax_amount ?? 0) - Number(form.withholding_amount))} 円になります` : '顧問料など源泉徴収のある報酬のときに入力')
                  : '月次・費用で相手科目が未払金・未払費用の契約だけ使えます'}>
                <div className="row tight">
                  <MoneyInput value={form.withholding_amount} onChange={(v) => upd('withholding_amount', v)} disabled={!withholdingOk && !form.withholding_amount} />
                  {withholdingOk && form.amount_excl != null && (
                    <button type="button" className="small" title="税抜金額 × 10.21%（100万円を超える部分は 20.42%）"
                      onClick={() => upd('withholding_amount', withholdingTax(Number(form.amount_excl)))}>計算</button>
                  )}
                </div>
              </Field>
              <Field label="インボイス区分">
                <Select value={form.invoice_type} onChange={(v) => upd('invoice_type', v || null)} options={options('invoice_type')} />
              </Field>
              <Field label="備考" wide>
                <input value={form.note ?? ''} onChange={(e) => upd('note', e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2>計上・科目</h2>
            <div className="grid">
              <Field label="損益科目">
                <AccountSelect value={form.pl_account_code ?? null} onChange={(v) => upd('pl_account_code', v)} accounts={accounts} filter={(a) => a.bs_pl !== 'BS' || a.code === 1520} />
              </Field>
              <Field label="損益 補助科目コード">
                <input value={form.pl_sub_code ?? ''} onChange={(e) => upd('pl_sub_code', e.target.value)} />
              </Field>
              <Field label="相手科目（経過勘定）" hint="支払月から自動提案します">
                <AccountSelect value={form.counter_account_code ?? null} onChange={(v) => upd('counter_account_code', v)} accounts={accounts} filter={(a) => a.is_accrual} />
              </Field>
              <Field label="相手 補助科目コード">
                <input value={form.counter_sub_code ?? ''} onChange={(e) => upd('counter_sub_code', e.target.value)} />
              </Field>
              <Field label="計上方式">
                <Select value={form.recognition_method} onChange={(v) => upd('recognition_method', v || null)} options={options('recognition_method')} />
              </Field>
              <Field label="端数処理">
                <Select value={form.rounding} onChange={(v) => upd('rounding', v || null)} options={options('rounding')} />
              </Field>
              <Field label="仕訳日ルール">
                <Select value={form.journal_date_rule} onChange={(v) => upd('journal_date_rule', v || null)} options={options('journal_date_rule')} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2>管理・証憑</h2>
            <div className="grid">
              <Field label="稟議書NO"><input value={form.ringi_no ?? ''} onChange={(e) => upd('ringi_no', e.target.value)} /></Field>
              <Field label="契約書URL" wide>
                <div className="row tight">
                  <input value={form.contract_url ?? ''} onChange={(e) => upd('contract_url', e.target.value)} />
                  {form.contract_url && (
                    <a className="button small" href={form.contract_url} target="_blank" rel="noreferrer">開く</a>
                  )}
                </div>
              </Field>
              <Field label="備考" wide><textarea rows={2} value={form.note2 ?? ''} onChange={(e) => upd('note2', e.target.value || null)} /></Field>
            </div>
          </section>
        </fieldset>
      )}

      {tab === 'alloc' && (
        <section className="card">
          <h2>按分（ビル／ホテル等への配賦）</h2>
          <p className="muted small">
            1つの契約を複数の物件（部門）に分けて計上する場合に設定します。行が無い場合は契約の物件に100%計上します。
            金額の比率で月次計上額を按分し、端数は最大の行で調整します。
          </p>
          <fieldset disabled={readOnly} className="plain">
            <table className="data compact">
              <thead>
                <tr><th>物件（部門）</th><th>内容</th><th className="r">税抜金額</th><th className="r">比率</th><th /></tr>
              </thead>
              <tbody>
                {allocs.map((a, i) => (
                  <tr key={i}>
                    <td>
                      <Select
                        value={a.property_code}
                        onChange={(v) => setAllocs((xs) => xs.map((x, j) => (j === i ? { ...x, property_code: Number(v) } : x)))}
                        options={masters.properties.map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }))}
                      />
                    </td>
                    <td><input value={a.label ?? ''} onChange={(e) => setAllocs((xs) => xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></td>
                    <td className="r"><MoneyInput value={a.amount_excl} onChange={(v) => setAllocs((xs) => xs.map((x, j) => (j === i ? { ...x, amount_excl: v ?? 0 } : x)))} /></td>
                    <td className="r mono">{allocTotal ? ((Number(a.amount_excl) / allocTotal) * 100).toFixed(1) + '%' : ''}</td>
                    <td><button className="small" onClick={() => setAllocs((xs) => xs.filter((_, j) => j !== i))}>削除</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={2}>合計</td><td className="r mono">{yen(allocTotal)}</td><td /><td /></tr>
              </tfoot>
            </table>
            <button onClick={() => setAllocs((xs) => [...xs, { property_code: form.property_code ?? 0, label: '', amount_excl: 0, sort: xs.length }])}>行を追加</button>
          </fieldset>
        </section>
      )}

      {tab === 'items' && (
        <section className="card">
          <h2>契約内訳・科目明細</h2>
          <p className="muted small">
            内訳（清掃・設備管理・警備など）を記録します。<b>損益科目を入れた行があると、月次計上の計上仕訳をその行の金額の割合で科目ごとに分けます</b>
            （行数の上限なし。按分があるときは物件ごと × 科目ごと）。支払の仕訳は契約1本のままです。科目を入れない行は計上に影響しません。
          </p>
          {lineIssue && <Notice tone="warn">{lineIssue}</Notice>}
          <fieldset disabled={readOnly} className="plain">
            <table className="data compact">
              <thead><tr><th>項目</th><th className="r">税抜金額</th><th>損益科目</th><th>補助科目</th><th>メモ</th><th /></tr></thead>
              <tbody>
                {items.map((x, i) => (
                  <tr key={i}>
                    <td><input value={x.item_name} onChange={(e) => setItems((xs) => xs.map((y, j) => (j === i ? { ...y, item_name: e.target.value } : y)))} /></td>
                    <td className="r"><MoneyInput value={x.amount_excl} onChange={(v) => setItems((xs) => xs.map((y, j) => (j === i ? { ...y, amount_excl: v } : y)))} /></td>
                    <td><AccountSelect value={x.pl_account_code ?? null} accounts={accounts} filter={(a) => a.bs_pl !== 'BS' || a.code === 1520}
                      onChange={(v) => setItems((xs) => xs.map((y, j) => (j === i ? { ...y, pl_account_code: v } : y)))} /></td>
                    <td><input className="narrow" value={x.pl_sub_code ?? ''} onChange={(e) => setItems((xs) => xs.map((y, j) => (j === i ? { ...y, pl_sub_code: e.target.value || null } : y)))} /></td>
                    <td><input value={x.note ?? ''} onChange={(e) => setItems((xs) => xs.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)))} /></td>
                    <td><button className="small" onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}>削除</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>合計</td><td className="r mono">{yen(items.reduce((a, b) => a + Number(b.amount_excl ?? 0), 0))}</td>
                  <td colSpan={4} className="small muted">{lineSum != null ? `科目明細の合計 ${yen(lineSum)}／税抜契約金額 ${yen(Number(form.amount_excl ?? 0))}` : ''}</td></tr>
              </tfoot>
            </table>
            <button onClick={() => setItems((xs) => [...xs, { item_name: '', amount_excl: null, note: null, sort: xs.length, pl_account_code: null, pl_sub_code: null }])}>行を追加</button>
          </fieldset>
        </section>
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
