import logoImg from '../assets/logo-vicio.png'

/** Logo oficial da Vício. variant 'light' aplica filtro branco (sidebar escura). */
export default function Logo({ size = 28, variant = 'dark' }) {
  const filter = variant === 'light' ? 'brightness(0) invert(1)' : 'none'
  return (
    <div className="flex items-center select-none">
      <img
        src={logoImg}
        alt="Vício — Vício de uma Estudante"
        style={{ height: size, width: 'auto', filter }}
        draggable={false}
      />
    </div>
  )
}
