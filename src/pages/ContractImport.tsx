import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, check } from '../lib/supabase'
import { useSession } from '../lib/session'
import { downloadCsvUtf8, yen } from '../lib/format'
import { Badge, ErrorBox, Notice, PageHeader } from '../components/ui'
import { IMPORT_COLUMNS, parseCsv, readImport, templateRows, type ImportResult } from '../lib/contractImport'

/** 契約の一括取り込み（新規登録のみ。既存の契約は変更しない） */
export default function ContractImport() {
  const { masters, options, isAccounting, canEdit, reloadMasters, propertyName } = useSession()
  const [fileName, setFileName] = useState('')
  const [table, setTable] = useState<string[][] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ line: number; id: number; no: number; name: string }[] | null>(null)
  const [showGuide, setShowGuide] = useState(false)

  const result: ImportResult | null = useMemo(
    () => (table ? readImport(table, { ...masters, options, isAccounting }) : null),
    [table, masters, options, isAccounting],
  )
  const ok = result?.rows.filter((r) => r.errors.length === 0) ?? []
  const ng = result?.rows.filter((r) => r.errors.length > 0) ?? []

  async function onFile(f: File | undefined) {
    setError(null)
    setDone(null)
    setTable(null)
    if (!f) return
    setFileName(f.name)
    try {
      // Excel で保存した CSV は Shift_JIS、テンプレートのままなら UTF-8。どちらも読む
      const buf = new Uint8Array(await f.arrayBuffer())
      const { default: Encoding } = await import('encoding-japanese')
      const enc = Encoding.detect(buf) || 'UTF8'
      const text = Encoding.convert(buf, { to: 'UNICODE', from: enc, type: 'string' }) as unknown as string
      setTable(parseCsv(text))
    } catch (e) {
      setError(`ファイルを読み込めませんでした：${(e as Error).message}`)
    }
  }

  async function register() {
    if (!ok.length) return
    setBusy(true)
    setError(null)
    const created: NonNullable<typeof done> = []
    try {
      // 取引先マスタに無い取引先を先に登録
      const vendors = new Map(ok.filter((r) => r.newVendor).map((r) => [r.newVendor!.code, r.newVendor!.name]))
      if (vendors.size) {
        check(await supabase.from('ct_vendors').upsert([...vendors].map(([code, name]) => ({ code, name })), { onConflict: 'code', ignoreDuplicates: true }))
      }
      // 契約IDは物件ごとの連番なので、1件ずつ採番して登録する
      for (const r of ok) {
        const no = check(await supabase.rpc('ct_next_contract_no', { p_property_code: r.values.property_code })) as number
        const row = check(await supabase.from('ct_contracts').insert({ ...r.values, contract_no: no }).select('id, contract_no, contract_name').single()) as { id: number; contract_no: number; contract_name: string }
        created.push({ line: r.line, id: row.id, no: row.contract_no, name: row.contract_name })
      }
      if (vendors.size) await reloadMasters()
      setDone(created)
      setTable(null)
    } catch (e) {
      setError(`${created.length} 件登録したところで止まりました：${(e as Error).message}`)
      setDone(created)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="契約の一括取り込み"
        sub="テンプレート（CSV）に入力した契約を、まとめて新規登録します。既存の契約は変更しません。"
        actions={
          <>
            <Link className="button" to="/contracts">一覧へ</Link>
            <button onClick={() => downloadCsvUtf8(templateRows(), '契約取り込みテンプレート.csv')}>テンプレートをダウンロード</button>
          </>
        }
      />
      <ErrorBox error={error} />

      <section className="card">
        <h2>使い方</h2>
        <ol className="steps">
          <li>「テンプレートをダウンロード」を押し、Excel で開きます。2行目は記入例です（取り込まれないので、消しても残してもかまいません）。</li>
          <li>3行目から1行に1契約ずつ入力し、<b>CSV 形式のまま</b>保存します（Excel の「CSV UTF-8」「CSV（コンマ区切り）」どちらでも可）。</li>
          <li>下でファイルを選ぶと、行ごとのチェック結果が出ます。エラーのない行だけ登録できます。</li>
        </ol>
        <p className="muted small">
          見出しに * の付いた列は必須です。契約IDは物件ごとに自動で採番します。按分・内訳は、登録後に契約編集で入力してください。
          <button className="link" onClick={() => setShowGuide((v) => !v)}>{showGuide ? '列の説明を閉じる' : '列の説明を見る'}</button>
        </p>
        {showGuide && (
          <div className="table-wrap">
            <table className="data compact">
              <thead><tr><th>列</th><th>必須</th><th>入力内容</th><th>記入例</th></tr></thead>
              <tbody>
                {IMPORT_COLUMNS.map((c) => (
                  <tr key={c.key}>
                    <td className="nowrap">{c.label}</td>
                    <td>{c.required ? '必須' : ''}</td>
                    <td className="small">{c.note}{c.category && c.category !== '__tax' ? `（選択肢：${options(c.category).join('・')}）` : ''}{c.category === '__tax' ? `（選択肢：${masters.taxCodes.map((t) => t.name).join('・')}）` : ''}</td>
                    <td className="small mono">{c.example}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>ファイルを選ぶ</h2>
        <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} disabled={!canEdit || busy} />
        {!canEdit && <p className="muted small">閲覧権限のため取り込めません。</p>}
      </section>

      {done && (
        <Notice tone="ok">
          {done.length} 件の契約を登録しました。
          <ul className="link-list">
            {done.map((d) => <li key={d.id}><Link to={`/contracts/${d.id}`}>{d.no}</Link>　{d.name}<span className="muted small">（{d.line}行目）</span></li>)}
          </ul>
        </Notice>
      )}

      {result && (
        <section className="card">
          <div className="row wrap">
            <h2>チェック結果：{fileName}</h2>
            <span className="spacer" />
            <Badge tone="ok">登録できる {ok.length} 件</Badge>
            <Badge tone={ng.length ? 'bad' : 'neutral'}>エラー {ng.length} 件</Badge>
            <button className="primary" onClick={register} disabled={busy || !ok.length || result.missingColumns.length > 0}>
              {busy ? '登録中…' : `エラーのない ${ok.length} 件を登録`}
            </button>
          </div>
          {result.missingColumns.length > 0 && (
            <Notice tone="warn">必須の列が見つかりません：{result.missingColumns.join('・')}（テンプレートの見出しを変えずに使ってください）</Notice>
          )}
          {result.unknownColumns.length > 0 && (
            <p className="muted small">テンプレートに無い列は読み飛ばします：{result.unknownColumns.join('・')}</p>
          )}
          {result.rows.length === 0 ? (
            <p className="muted">取り込む行がありません。</p>
          ) : (
            <div className="table-wrap">
              <table className="data compact">
                <thead><tr><th>行</th><th>判定</th><th>物件</th><th>契約名</th><th>取引先</th><th>請求／支払</th><th className="r">税抜金額</th><th>科目</th><th>確認事項</th></tr></thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.line} className={r.errors.length ? 'row-error' : ''}>
                      <td className="mono">{r.line}</td>
                      <td>{r.errors.length ? <Badge tone="bad">エラー</Badge> : <Badge tone="ok">OK</Badge>}</td>
                      <td className="nowrap">{r.values.property_code != null ? `${r.values.property_code} ${propertyName(r.values.property_code)}` : ''}</td>
                      <td>{r.values.contract_name}</td>
                      <td className="small">{r.values.vendor_name}</td>
                      <td className="nowrap small">{[r.values.billing_cycle, r.values.payment_timing, r.values.payment_method].filter(Boolean).join('／')}</td>
                      <td className="r mono">{yen(r.values.amount_excl)}</td>
                      <td className="nowrap small">{r.values.pl_account_code} → {r.values.counter_account_code}</td>
                      <td className="small">
                        {r.errors.map((e) => <div key={e} className="danger-text">{e}</div>)}
                        {r.warnings.map((w) => <div key={w} className="muted">{w}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  )
}
