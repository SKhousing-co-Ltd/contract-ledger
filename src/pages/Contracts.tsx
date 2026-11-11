import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase, check } from '../lib/supabase'
import { useSession } from '../lib/session'
import type { ContractView } from '../lib/types'
import { dateJa, downloadCsvUtf8, yen } from '../lib/format'
import { Badge, Empty, ErrorBox, Loading, PageHeader, Select, judgementTone } from '../components/ui'
import { TERM_KIND_LABEL, TERM_SOURCE_LABEL, termInfo, type TermKind } from '../lib/term'

/** 終了日の欄：何の日付かが分かるように表示する */
function TermCell({ c }: { c: ContractView }) {
  const t = termInfo(c)
  switch (t.kind) {
    case 'none':
      return <span className="muted">—</span>
    case 'cancel':
      return <span title="解約日">解約 {dateJa(t.date)}</span>
    case 'expired':
      return <span className="danger-text" title="自動更新ではない契約で、サービス終了日を過ぎています">期限切れ {dateJa(t.date)}</span>
    case 'auto':
      return (
        <span title={`今期の終了日（次回更新日）。元の終了日 ${dateJa(t.originalEnd)}、${t.termMonths}か月ごとに自動更新（${TERM_SOURCE_LABEL[t.termSource!]}）`}>
          {dateJa(t.date)} <span className="tag">自動更新</span>
        </span>
      )
    default:
      return <span title="サービス終了日">{dateJa(t.date)}</span>
  }
}

export async function fetchContracts(): Promise<ContractView[]> {
  const res = await supabase
    .from('ct_contracts_v')
    .select('*')
    .order('property_code')
    .order('contract_no')
    .order('version')
    .range(0, 9999)
  return check(res) as ContractView[]
}

export default function Contracts() {
  const { masters, options } = useSession()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [rows, setRows] = useState<ContractView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 検索語は入力欄のローカル状態で持つ。URL と直結すると、日本語入力（IME）の変換中に
  // 値が読み戻されて変換が崩れるため、URL への反映は変換確定後に少し遅らせて行う
  const urlQ = params.get('q') ?? ''
  const [q, setQ] = useState(urlQ)
  const composing = useRef(false)
  const prop = params.get('property') ?? ''
  const status = params.get('status') ?? ''
  const target = params.get('target') ?? ''
  const term = params.get('term') ?? ''
  const latest = params.get('latest') !== '0'

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params)
    if (v) p.set(k, v)
    else p.delete(k)
    setParams(p, { replace: true })
  }

  useEffect(() => {
    fetchContracts().then(setRows).catch((e) => setError(e.message))
  }, [])

  // 入力が止まってから URL に書き込む（戻る・リンク共有で検索語を残すため）
  useEffect(() => {
    if (composing.current || q === urlQ) return
    const t = setTimeout(() => set('q', q), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  // 戻る・進むなどで URL 側が変わったときは入力欄に反映する
  useEffect(() => {
    if (!composing.current) setQ(urlQ)
  }, [urlQ])

  const filtered = useMemo(() => {
    if (!rows) return []
    const maxVer = new Map<number, number>()
    rows.forEach((r) => maxVer.set(r.contract_no, Math.max(maxVer.get(r.contract_no) ?? 0, r.version)))
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return rows.filter((r) => {
      if (latest && r.version !== maxVer.get(r.contract_no)) return false
      if (prop && String(r.property_code) !== prop) return false
      if (status && r.status !== status) return false
      if (target && r.calc_target !== target) return false
      if (term && termInfo(r).kind !== term) return false
      if (words.length) {
        const hay = [r.contract_no, r.vendor_name, r.vendor_code, r.contract_name, r.property_name, r.pl_account_name, r.note, r.ringi_no]
          .join(' ')
          .toLowerCase()
        if (!words.every((w) => hay.includes(w))) return false
      }
      return true
    })
  }, [rows, q, prop, status, target, term, latest])

  const totals = useMemo(() => {
    let m = 0
    let y = 0
    filtered.forEach((r) => {
      if (r.is_active && r.status !== '解約済') {
        m += Number(r.monthly_excl ?? 0)
        y += Number(r.annual_excl ?? 0)
      }
    })
    return { m, y }
  }, [filtered])

  function exportCsv() {
    const head = ['契約ID', '枝番', '有効', '契約状態', '物件コード', '物件名', '取引先コード', '取引先名', '契約名', '請求サイクル', '支払月', '支払方法', '金額基準', '税抜金額', '消費税', '税込金額', '月額換算(税抜)', '年額換算(税抜)', '損益科目', '相手科目', 'サービス開始日', 'サービス終了日', '解約日', '更新区分', '更新期間(か月)', '期間の状況', '今期の終了日', '計上対象', '確認事項']
    const body = filtered.map((r) => {
      const t = termInfo(r)
      return [
        r.contract_no, r.version, r.is_active ? '有効' : '無効', r.status, r.property_code, r.property_name, r.vendor_code, r.vendor_name,
        r.contract_name, r.billing_cycle, r.payment_timing, r.payment_method, r.amount_basis, r.amount_excl, r.tax_amount, r.amount_incl,
        r.monthly_excl, r.annual_excl, r.pl_account_name, r.counter_account_name, r.service_start, r.service_end, r.cancel_date,
        r.renewal_type, t.termMonths ?? r.renewal_term_months, TERM_KIND_LABEL[t.kind], t.kind === 'auto' || t.kind === 'active' ? t.date : '',
        r.calc_target, r.issues,
      ]
    })
    downloadCsvUtf8([head, ...body], `契約一覧_${new Date().toISOString().slice(0, 10)}.csv`)
  }

  return (
    <>
      <PageHeader
        title="契約一覧"
        sub={rows ? `${filtered.length} 件表示（全 ${rows.length} 行）・月額換算 ${yen(totals.m)} 円／年額換算 ${yen(totals.y)} 円（税抜・有効かつ解約済以外）` : undefined}
        actions={
          <>
            <button onClick={exportCsv} disabled={!filtered.length}>CSV出力</button>
            <Link className="button" to="/contracts/import">一括取り込み</Link>
            <Link className="button primary" to="/contracts/new">新規登録</Link>
          </>
        }
      />
      <ErrorBox error={error} />
      <div className="filters">
        <input className="search" placeholder="検索（取引先・契約名・契約ID・稟議NO）" value={q}
          onChange={(e) => setQ(e.target.value)}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={(e) => { composing.current = false; setQ(e.currentTarget.value) }} />
        <Select
          value={prop}
          onChange={(v) => set('property', v)}
          placeholder="すべての物件"
          options={masters.properties.map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }))}
        />
        <Select value={status} onChange={(v) => set('status', v)} placeholder="すべての状態" options={options('status')} />
        <Select value={target} onChange={(v) => set('target', v)} placeholder="計上対象：すべて" options={['対象', '要設定', '対象外']} />
        <Select value={term} onChange={(v) => set('term', v)} placeholder="契約期間：すべて"
          options={(['active', 'auto', 'expired', 'cancel', 'none'] as TermKind[]).map((k) => ({ value: k, label: TERM_KIND_LABEL[k] }))} />
        <label className="check">
          <input type="checkbox" checked={latest} onChange={(e) => set('latest', e.target.checked ? '' : '0')} />
          最新の枝番のみ
        </label>
      </div>
      {!rows ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <Empty>条件に合う契約はありません。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>契約ID</th>
                <th>物件</th>
                <th>取引先</th>
                <th>契約名</th>
                <th>状態</th>
                <th>請求／支払</th>
                <th>基準</th>
                <th className="r">税抜金額</th>
                <th className="r">月額換算</th>
                <th>損益科目</th>
                <th>相手科目</th>
                <th title="解約日／今期の終了日（自動更新中は次回更新日）">終了日</th>
                <th>計上</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className={`clickable${r.status === '解約済' || r.status === '停止' ? ' dim' : ''}`} onClick={() => nav(`/contracts/${r.id}`)}>
                  <td className="mono nowrap">
                    {r.contract_no}
                    <span className="ver">-{r.version}</span>
                  </td>
                  <td className="nowrap">
                    {r.property_name}
                    {r.allocation_count > 0 && <span className="tag" title="複数物件に按分">按分</span>}
                    {r.accounting_only && <span className="tag tag-lock" title="総務経理部のみ閲覧">経理</span>}
                  </td>
                  <td className="ellipsis" title={r.vendor_name ?? ''}>{r.vendor_name}</td>
                  <td className="ellipsis" title={r.contract_name}>{r.contract_name}</td>
                  <td><Badge tone={judgementTone(r.status)}>{r.status}</Badge></td>
                  <td className="nowrap small">{[r.billing_cycle, r.payment_timing].filter(Boolean).join('／')}{r.payment_method && <div className="muted">{r.payment_method}</div>}</td>
                  <td className="nowrap small">{r.amount_basis}</td>
                  <td className="r mono">{yen(r.amount_excl)}</td>
                  <td className="r mono">{yen(r.monthly_excl)}</td>
                  <td className="nowrap small">{r.pl_account_name}</td>
                  <td className="nowrap small">{r.counter_account_name}</td>
                  <td className="nowrap small"><TermCell c={r} /></td>
                  <td title={r.issues ?? ''}>
                    <Badge tone={judgementTone(r.calc_target)}>{r.calc_target}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
