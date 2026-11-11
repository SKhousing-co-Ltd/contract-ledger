import { createHashRouter, Navigate, NavLink, Route, RouterProvider, Routes } from 'react-router-dom'
import { SessionProvider, useSession } from './lib/session'
import { isConfigured, supabase } from './lib/supabase'
import { Loading } from './components/ui'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Contracts from './pages/Contracts'
import ContractEdit from './pages/ContractEdit'
import ContractImport from './pages/ContractImport'
import PropertySummary from './pages/PropertySummary'
import Monthly from './pages/Monthly'
import Journals from './pages/Journals'
import Balances from './pages/Balances'
import Masters from './pages/Masters'
import Users from './pages/Users'

export default function App() {
  if (!isConfigured) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h1>設定が必要です</h1>
          <p>
            <code>.env</code> に <code>VITE_SUPABASE_URL</code> と <code>VITE_SUPABASE_ANON_KEY</code>
            を設定してください（README 参照）。
          </p>
        </div>
      </div>
    )
  }
  return (
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  )
}

// 画面の定義は Shell 内の <Routes> に置いたまま、データルーターで包む
// （未保存の変更がある画面で移動を確認する useBlocker はデータルーターでしか使えない）
const router = createHashRouter([{ path: '*', element: <Shell /> }])

function Shell() {
  const { session, profile, loading, isAccounting, isAdmin } = useSession()
  if (!session) return <Login />
  if (loading) return <Loading />
  if (!profile) return <NoProfile email={session.user.email ?? ''} userId={session.user.id} />

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>▤</span>
          <span>
            定期契約
            <small>経過勘定管理</small>
          </span>
        </div>
        <nav>
          <NavLink to="/" end>ダッシュボード</NavLink>
          <div className="nav-group">契約</div>
          <NavLink to="/contracts">契約一覧</NavLink>
          <NavLink to="/contracts/new">新規登録</NavLink>
          <NavLink to="/properties">物件別一覧</NavLink>
          <div className="nav-group">月次</div>
          <NavLink to="/monthly">月次計上</NavLink>
          {isAccounting && <NavLink to="/journals">仕訳・CSV出力</NavLink>}
          {isAccounting && <NavLink to="/balances">経過勘定残高</NavLink>}
          <div className="nav-group">設定</div>
          <NavLink to="/masters">マスタ</NavLink>
          {isAdmin && <NavLink to="/users">ユーザー権限</NavLink>}
        </nav>
        <div className="me">
          <div className="me-name">{profile.display_name || session.user.email}</div>
          <div className="me-dept">
            {profile.department}・{profile.role === 'admin' ? '管理者' : profile.role === 'editor' ? '編集' : '閲覧'}
          </div>
          <button className="link" onClick={() => supabase.auth.signOut()}>ログアウト</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/contracts" element={<Contracts />} />
          <Route path="/contracts/new" element={<ContractEdit />} />
          <Route path="/contracts/import" element={<ContractImport />} />
          <Route path="/contracts/:id" element={<ContractEdit />} />
          <Route path="/properties" element={<PropertySummary />} />
          <Route path="/monthly" element={<Monthly />} />
          {isAccounting && <Route path="/journals" element={<Journals />} />}
          {isAccounting && <Route path="/balances" element={<Balances />} />}
          <Route path="/masters" element={<Masters />} />
          {isAdmin && <Route path="/users" element={<Users />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}

function NoProfile({ email, userId }: { email: string; userId: string }) {
  return (
    <div className="center-screen">
      <div className="card narrow">
        <h1>利用権限が未設定です</h1>
        <p>
          {email} でログインしていますが、このアプリの部署・権限がまだ登録されていません。
          管理者に「ユーザー権限」画面での登録を依頼してください。
        </p>
        <p className="muted small">ユーザーID: {userId}</p>
        <button onClick={() => supabase.auth.signOut()}>ログアウト</button>
      </div>
    </div>
  )
}
