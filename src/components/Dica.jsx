import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

/**
 * (i) discreto no canto superior direito do card — hover mostra a regra
 * aplicada naquele visual. O card pai precisa de `relative`.
 *
 * O balão é renderizado num portal no <body> com posição fixa: assim ele
 * nunca fica atrás de outros cards (stacking context de backdrop-blur)
 * nem é cortado por overflow-hidden.
 */
const LARGURA = 288 // w-72

export default function Dica({ texto, claro = false }) {
  const iconeRef = useRef(null)
  const [pos, setPos] = useState(null) // {top, left} ou null (fechado)

  const abrir = () => {
    const r = iconeRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(8, Math.min(r.right - LARGURA, window.innerWidth - LARGURA - 8))
    setPos({ top: r.bottom + 6, left })
  }

  return (
    <span
      ref={iconeRef}
      className="absolute right-3 top-3 z-10 inline-flex"
      onMouseEnter={abrir}
      onMouseLeave={() => setPos(null)}
    >
      <Info
        size={13}
        className={`cursor-help transition ${claro ? 'text-white/40 hover:text-white' : 'text-ink-300 hover:text-vicio-500 dark:text-ink-500 dark:hover:text-vicio-300'}`}
      />
      {pos && createPortal(
        <span
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: LARGURA, zIndex: 9999 }}
          className="pointer-events-none block rounded-xl border border-ink-100 bg-white px-3.5 py-2.5 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-ink-600 shadow-soft dark:border-ink-600 dark:bg-ink-800 dark:text-ink-200"
        >
          {texto}
        </span>,
        document.body,
      )}
    </span>
  )
}
