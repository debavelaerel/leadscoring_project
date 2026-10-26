import { useState } from 'react'
import { Menu, Sun, Moon } from 'lucide-react'
import Sidebar from './components/Sidebar.jsx'
import Logo from './components/Logo.jsx'
import UploadPage from './pages/UploadPage.jsx'
import DatasetsPage from './pages/DatasetsPage.jsx'
import ModeloPage from './pages/ModeloPage.jsx'
import CaptacaoPage from './pages/CaptacaoPage.jsx'
import AnalysisPage from './pages/AnalysisPage.jsx'
import LeadsPage from './pages/LeadsPage.jsx'
import { useTheme } from './lib/theme.jsx'

const NAV_MOBILE = [
  { id: 'upload', label: 'Nova análise' },
  { id: 'bases', label: 'Bases' },
  { id: 'modelo', label: 'Modelo' },
  { id: 'captacao', label: 'Captação' },
  { id: 'analise', label: 'Lead Score' },
  { id: 'leads', label: 'Leads' },
]

export default function App() {
  const [page, setPage] = useState('upload')
  const [analise, setAnalise] = useState(null) // { id, meta, stats }
  const [mobileOpen, setMobileOpen] = useState(false)
  const [baseCaptacao, setBaseCaptacao] = useState(null) // base recém-enviada pra pontuar
  const { theme, toggleTheme, sidebarCollapsed } = useTheme()
  const isDark = theme === 'dark'

  const aoConcluirAnalise = (resultado) => {
    setAnalise(resultado)
    setPage('analise')
  }

  return (
    <div className="min-h-screen">
      <Sidebar
        current={page}
        onChange={(p) => { setPage(p); setMobileOpen(false) }}
        temAnalise={!!analise}
      />

      {/* Top bar mobile */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-ink-100 bg-white/80 px-4 py-3 backdrop-blur lg:hidden dark:border-ink-700/60 dark:bg-ink-900/80">
        <Logo size={26} variant={isDark ? 'light' : 'dark'} />
        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            aria-label={isDark ? 'Tema claro' : 'Tema escuro'}
            className="grid h-9 w-9 place-items-center rounded-lg border border-ink-100 bg-white text-vicio-700 dark:border-ink-700 dark:bg-ink-800 dark:text-accent-lime"
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="grid h-9 w-9 place-items-center rounded-lg bg-vicio-600 text-white"
            aria-label="Menu"
          >
            <Menu size={18} />
          </button>
        </div>
      </div>

      {/* Drawer mobile */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="flex-1 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="w-64 bg-gradient-vicio-dark p-6 text-white">
            <Logo size={30} variant="light" />
            <p className="mt-3 text-xs text-white/60">Lead Score</p>
            <ul className="mt-6 space-y-1">
              {NAV_MOBILE.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => { setPage(n.id); setMobileOpen(false) }}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${page === n.id ? 'bg-white/15' : 'hover:bg-white/10'}`}
                  >
                    {n.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <main className={`transition-[padding] duration-200 ${sidebarCollapsed ? 'lg:pl-16' : 'lg:pl-64'}`}>
        {page === 'upload' && (
          <UploadPage
            onConcluir={aoConcluirAnalise}
            onPontuar={(id) => { setBaseCaptacao(id); setPage('captacao') }}
            irParaBases={() => setPage('bases')}
          />
        )}
        {page === 'bases' && <DatasetsPage onAbrirAnalise={aoConcluirAnalise} irParaUpload={() => setPage('upload')} />}
        {page === 'modelo' && <ModeloPage irParaBases={() => setPage('bases')} />}
        {page === 'captacao' && <CaptacaoPage baseInicial={baseCaptacao} irParaUpload={() => setPage('upload')} />}
        {page === 'analise' && <AnalysisPage analise={analise} irParaUpload={() => setPage('upload')} />}
        {page === 'leads' && <LeadsPage analise={analise} irParaUpload={() => setPage('upload')} />}
      </main>
    </div>
  )
}
