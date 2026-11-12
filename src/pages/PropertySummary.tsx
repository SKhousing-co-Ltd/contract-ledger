import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, check } from '../lib/supabase'
import { useSession } from '../lib/session'
import type { ContractView } from '../lib/types'
import { downloadCsvUtf8, yen } from '../lib/format'
import { ErrorBox, Loading, PageHeader, Select } from '../components/ui'
import { fetchContracts } from './Contracts'

interface Line {
  property_code: number
  c: ContractView
  monthly: number
  annual: number
  ratio: number
}

export default function PropertySummary() {
  const { masters, propertyName } = useSession()
  const [rows, setRows] = useState<ContractView[] | null>(null)
  // 金額の内訳（明細）：物件・科目ごとの割り振り。旧来の按分しか無い契約は按分で割り振る
  const [allocs, setAllocs] = useState<{ contract_id: number; property_code: number | null; amount_excl: number; pl_account_code: number | null }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [account, setAccount] = useState('')
  const [kind, setKind] = useState('')
  const [split, setSplit] = useState(true)
  const [tax, setTax] = useState<'excl' | 'incl'>('excl')
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([
      fetchContracts(),
      supabase.from('ct_contract_items').select('contract_id, property_code, amount_excl, pl_account_code').not('pl_account_code', 'is', null).range(0, 9999),
      supabase.from('ct_contract_allocations').select('contract_id, property_code, amount_excl').range(0, 9999),
    ])
      .then(([c, it, a]) => {
        setRows(c)
        const items = check(it) as { contract_id: number; property_code: number | null; amount_excl: number; pl_account_code: number | null }[]
        const withItems = new Set(items.map((x) => x.contract_id))
        const legacy = (check(a) as { contract_id: number; property_code: number; amount_excl: number }[])
          .filter((x) => !withItems.has(x.contract_id)).map((x) => ({ ...x, pl_account_code: null }))
        setAllocs([...items, ...legacy])
      })
      .catch((e) => setError(e.message))
  }, [])

  const accountsUsed = useMemo(() => {
    const set = new Set([...(rows ?? []).map((r) => r.pl_account_code), ...allocs.map((a) => a.pl_account_code)].filter((x): x is number => x != null))
    return masters.accounts.filter((a) => set.has(a.code))
  }, [rows, allocs, masters.accounts])

  const data = useMemo(() => {
    if (!rows) return null
    const live = rows.filter((r) => r.is_active && (r.status === '契約中' || r.status === '解約予定'))
    const lines: Line[] = []
    live.forEach((c) => {
      const factor = tax === 'incl' && c.amount_excl ? Number(c.amount_incl ?? c.amount_excl) / Number(c.amount_excl) : 1
      const m = Number(c.monthly_excl ?? 0) * factor
      const y = Number(c.annual_excl ?? 0) * factor
      const al = allocs.filter((a) => a.contract_id === c.id)
      const tot = al.reduce((s, a) => s + Number(a.amount_excl), 0)
      // 科目の絞り込みは明細の科目で行う（明細の無い契約は契約の科目）
      const accOf = (a?: { pl_account_code: number | null }) => a?.pl_account_code ?? c.pl_account_code
      if (al.length && tot && (split || account)) {
        al.filter((a) => !account || String(accOf(a)) === account).forEach((a) => lines.push({
          property_code: split ? a.property_code ?? c.property_code : c.property_code, c,
          monthly: (m * Number(a.amount_excl)) / tot, annual: (y * Number(a.amount_excl)) / tot, ratio: Number(a.amount_excl) / tot,
        }))
      } else if (!account || String(accOf()) === account) lines.push({ property_code: c.property_code, c, monthly: m, annual: y, ratio: 1 })
    })
    const byProp = new Map<number, Line[]>()
    lines.forEach((l) => byProp.set(l.property_code, [...(byProp.get(l.property_code) ?? []), l]))
    const props = masters.properties
      .filter((p) => byProp.has(p.code) && (!kind || p.kind === kind))
      .map((p) => {
        const ls = byProp.get(p.code)!
        return {
          code: p.code,
          name: p.name,
          kind: p.kind,
          lines: ls,
          count: ls.length,
          variable: ls.filter((l) => l.c.amount_basis === '従量' || l.c.amount_basis === '手入力').length,
          monthly: ls.reduce((a, l) => a + l.monthly, 0),
          annual: ls.reduce((a, l) => a + l.annual, 0),
        }
      })
    // 物件マスタに無いコード
    byProp.forEach((ls, code) => {
      if (!masters.properties.some((p) => p.code === code) && !kind)
        props.push({ code, name: propertyName(code), kind: '', lines: ls, count: ls.length, variable: 0, monthly: ls.reduce((a, l) => a + l.monthly, 0), annual: ls.reduce((a, l) => a + l.annual, 0) })
    })
    return {
      props,
      total: { count: props.reduce((a, p) => a + p.count, 0), monthly: props.reduce((a, p) => a + p.monthly, 0), annual: props.reduce((a, p) => a + p.annual, 0) },
    }
  }, [rows, allocs, account, kind, split, tax, masters.properties, propertyName])

  const kinds = Array.from(new Set(masters.properties.map((p) => p.kind)))

  function exportCsv() {
    if (!data) return
    const head = ['物件コード', '物件名', '区分', '契約数', `月額合計(${tax === 'excl' ? '税抜' : '税込'})`, `年額合計(${tax === 'excl' ? '税抜' : '税込'})`]
    const body = data.props.map((p) => [p.code, p.name, p.kind, p.count, Math.round(p.monthly), Math.round(p.annual)])
    body.push(['', '合計', '', data.total.count, Math.round(data.total.monthly), Math.round(data.total.annual)])
    downloadCsvUtf8([head, ...body], `物件別管理費一覧_${new Date().toISOString().slice(0, 10)}.csv`)
  }

  return (
    <>
      <PageHeader
        title="物件別一覧"
        sub="有効な契約（契約中・解約予定）の月額・年額。年額契約は÷12で月額換算、月額契約は×12で年額換算しています。従量・手入力の契約は金額に含みません。"
        actions={<button onClick={exportCsv} disabled={!data}>CSV出力</button>}
      />
      <ErrorBox error={error} />
      <div className="filters">
        <Select value={account} onChange={setAccount} placeholder="すべての損益科目" options={accountsUsed.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} />
        <Select value={kind} onChange={setKind} placeholder="すべての区分" options={kinds} />
        <Select value={tax} onChange={(v) => setTax((v || 'excl') as 'excl' | 'incl')} placeholder="税抜" options={[{ value: 'excl', label: '税抜' }, { value: 'incl', label: '税込' }]} />
        <label className="check">
          <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
          金額の内訳の物件に分ける（ビル／ホテルなど）
        </label>
      </div>
      {!data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>物件</th>
                <th>区分</th>
                <th className="r">契約数</th>
                <th className="r">うち変動</th>
                <th className="r">月額合計</th>
                <th className="r">年額合計</th>
              </tr>
            </thead>
            <tbody>
              {data.props.map((p) => (
                <Fragment key={p.code}>
                  <tr className="clickable" onClick={() => setOpen(open === p.code ? null : p.code)}>
                    <td className="nowrap">
                      <span className="caret">{open === p.code ? '▾' : '▸'}</span> {p.code} {p.name}
                      {masters.properties.find((x) => x.code === p.code)?.is_residential && <span className="tag" title="住宅（原価の課税仕入は共通対応）">住宅</span>}
                    </td>
                    <td className="small">{p.kind}</td>
                    <td className="r mono">{p.count}</td>
                    <td className="r mono">{p.variable || ''}</td>
                    <td className="r mono">{yen(p.monthly)}</td>
                    <td className="r mono">{yen(p.annual)}</td>
                  </tr>
                  {open === p.code &&
                    p.lines.map((l, i) => (
                      <tr key={i} className="sub-row">
                        <td colSpan={2}>
                          <Link to={`/contracts/${l.c.id}`}>{l.c.contract_no}-{l.c.version}</Link> {l.c.contract_name}
                          <span className="muted small">　{l.c.vendor_name}</span>
                          {l.ratio < 1 && <span className="tag">内訳 {(l.ratio * 100).toFixed(1)}%</span>}
                        </td>
                        <td className="small" colSpan={2}>{[l.c.billing_cycle, l.c.amount_basis, l.c.pl_account_name].filter(Boolean).join('・')}</td>
                        <td className="r mono">{yen(l.monthly)}</td>
                        <td className="r mono">{yen(l.annual)}</td>
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>全物件 合計</td>
                <td className="r mono">{data.total.count}</td>
                <td />
                <td className="r mono">{yen(data.total.monthly)}</td>
                <td className="r mono">{yen(data.total.annual)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}
