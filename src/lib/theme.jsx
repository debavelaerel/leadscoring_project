import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Tema (light/dark) + sidebar retrátil — mesmo padrão dos painéis Vício.
 */

const STORAGE_THEME = 'vicio.leadscore.theme'
const STORAGE_SIDEBAR = 'vicio.leadscore.sidebar.collapsed'

const ThemeContext = createContext({
  theme: 'dark',
  toggleTheme: () => {},
  sidebarCollapsed: false,
  toggleSidebar: () => {},
})

function getInitialTheme() {
  if (typeof window === 'undefined') return 'dark'
  const saved = window.localStorage?.getItem(STORAGE_THEME)
  if (saved === 'dark' || saved === 'light') return saved
  return 'dark' // padrão noturno
}

function getInitialSidebar() {
  if (typeof window === 'undefined') return false
  return window.localStorage?.getItem(STORAGE_SIDEBAR) === '1'
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(getInitialTheme)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(getInitialSidebar)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.style.colorScheme = theme
    try { window.localStorage.setItem(STORAGE_THEME, theme) } catch { /* noop */ }
  }, [theme])

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_SIDEBAR, sidebarCollapsed ? '1' : '0') } catch { /* noop */ }
  }, [sidebarCollapsed])

  return (
    <ThemeContext.Provider
      value={{
        theme,
        toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
        sidebarCollapsed,
        toggleSidebar: () => setSidebarCollapsed((v) => !v),
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
