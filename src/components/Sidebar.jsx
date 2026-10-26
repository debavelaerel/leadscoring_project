import {
  UploadCloud, Database, Boxes, Gauge, Users, Radar,
  ChevronLeft, ChevronRight, Sun, Moon,
} from 'lucide-react'
import { useTheme } from '../lib/theme.jsx'
import logoVicio from '../assets/logo-vicio.png'
import logoCheia from '../assets/logo-aprovados.png'

const NAV = [
  { id: 'upload',  label: 'Nova análise', icon: UploadCloud },
  { id: 'bases',   label: 'Bases',        icon: Database },
  { id: 'modelo',  label: 'Modelo',       icon: Boxes },
  { id: 'captacao', label: 'Captação',    icon: Radar },
  { id: 'analise', label: 'Lead Score',   icon: Gauge },
  { id: 'leads',   label: 'Leads',        icon: Users },
]

// telas que não dependem de ter uma análise carregada
const SEMPRE_LIBERADAS = new Set(['upload', 'bases', 'modelo', 'captacao'])

export default function Sidebar({ current, onChange, temAnalise }) {
  const { theme, toggleTheme, sidebarCollapsed: collapsed, toggleSidebar } = useTheme()
  const isDark = theme === 'dark'

  return (
    <aside
      className={`fixed left-0 top-0 z-20 hidden h-screen flex-col bg-gradient-vicio-dark text-white transition-[width] duration-200 lg:flex ${collapsed ? 'w-16' : 'w-64'}`}
    >
      {/* Logo + retrair */}
      <div className={`relative flex items-center pt-7 pb-6 ${collapsed ? 'justify-center px-2' : 'px-5'}`}>
        {collapsed ? (
          <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-lg bg-white/10">
            <img
              src={logoVicio}
              alt="Vício"
              className="h-7 w-auto object-contain"
              style={{ filter: 'brightness(0) invert(1)' }}
              draggable={false}
            />
          </div>
        ) : (
          <div className="flex w-full flex-col items-start">
            <img
              src={logoCheia}
              alt="Vício de uma Estudante"
              className="h-12 w-auto object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.25)]"
              draggable={false}
            />
            <div className="mt-2 flex items-center gap-2">
              <span className="h-px w-5 bg-accent-lime/70" />
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">
                painel · lead score
              </p>
            </div>
          </div>
        )}
        <button
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
          title={collapsed ? 'Expandir' : 'Recolher'}
          className="absolute -right-3 top-9 grid h-6 w-6 place-items-center rounded-full border border-white/10 bg-vicio-700 text-white shadow-md hover:bg-vicio-500"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>
      </div>

      {/* Nav */}
      <nav className={collapsed ? 'px-2' : 'px-3'}>
        {!collapsed && (
          <p className="px-3 pb-2 text-[10px] uppercase tracking-[0.18em] text-white/40">
            Lançamento
          </p>
        )}
        <ul className="space-y-1">
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = current === id
            const disabled = !SEMPRE_LIBERADAS.has(id) && !temAnalise
            return (
              <li key={id}>
                <button
                  onClick={() => !disabled && onChange(id)}
                  title={collapsed ? label : undefined}
                  className={`group flex w-full items-center rounded-xl text-sm transition
                    ${collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5'}
                    ${active ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'}
                    ${disabled ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''}`}
                >
                  <Icon size={18} className={active ? 'text-accent-lime' : 'text-white/70'} />
                  {!collapsed && <span className="font-medium">{label}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Rodapé */}
      <div className={`mt-auto space-y-2 pb-4 ${collapsed ? 'px-2' : 'px-3'}`}>
        <button
          onClick={toggleTheme}
          className={`flex w-full items-center rounded-xl border border-white/10 bg-white/5 text-sm text-white/80 hover:bg-white/10
            ${collapsed ? 'justify-center px-0 py-2' : 'gap-2 px-3 py-2'}`}
          title={isDark ? 'Tema claro' : 'Tema escuro'}
        >
          {isDark ? <Sun size={16} className="text-accent-lime" /> : <Moon size={16} className="text-accent-lime" />}
          {!collapsed && <span className="font-medium">{isDark ? 'Tema claro' : 'Tema escuro'}</span>}
        </button>
      </div>
    </aside>
  )
}
