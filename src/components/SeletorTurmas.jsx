import { useMemo } from 'react'
import { Check, Layers } from 'lucide-react'

/**
 * Escolha de turmas para o cruzamento.
 *
 * Uma captação vende vários produtos (40D, 60D, 90D…). Marcar só a 90D joga
 * quem comprou 40D pro lado dos não-compradores, o que inverte o sinal de gente
 * que converteu — por isso aqui é multi-seleção, agrupada por edição.
 *
 * valor = ["47|90D", "47|40D"]
 */
export default function SeletorTurmas({ turmas, valor = [], onChange, compacto = false }) {
  const porOab = useMemo(() => {
    const mapa = new Map()
    for (const t of turmas) {
      const lista = mapa.get(t.oab) || []
      lista.push(t)
      mapa.set(t.oab, lista)
    }
    return [...mapa.entries()].sort((a, b) => b[0] - a[0])
  }, [turmas])

  const marcadas = new Set(valor)
  const chave = (t) => `${t.oab}|${t.curso}`

  const alternar = (t) => {
    const k = chave(t)
    onChange(marcadas.has(k) ? valor.filter((v) => v !== k) : [...valor, k])
  }

  const alternarOab = (oab, lista) => {
    const chaves = lista.map(chave)
    const todas = chaves.every((k) => marcadas.has(k))
    onChange(todas ? valor.filter((v) => !chaves.includes(v)) : [...new Set([...valor, ...chaves])])
  }

  if (!turmas.length) return null

  return (
    <div className={compacto ? 'space-y-2' : 'space-y-3'}>
      {porOab.map(([oab, lista]) => {
        const chaves = lista.map(chave)
        const todas = chaves.every((k) => marcadas.has(k))
        const alunosOab = lista.reduce((s, t) => s + (t.alunos || 0), 0)
        return (
          <div key={oab}>
            <div className="mb-1.5 flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-300">
                OAB {oab}
              </p>
              <span className="text-[11px] text-ink-400 dark:text-ink-400">
                {alunosOab.toLocaleString('pt-BR')} alunos
              </span>
              <button
                type="button"
                onClick={() => alternarOab(oab, lista)}
                className="text-[11px] font-medium text-vicio-600 hover:underline dark:text-accent-lime"
              >
                {todas ? 'limpar' : 'marcar todas'}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {lista.map((t) => {
                const k = chave(t)
                const ativa = marcadas.has(k)
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => alternar(t)}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition
                      ${ativa
                        ? 'border-vicio-400 bg-vicio-50 text-vicio-800 dark:border-vicio-500 dark:bg-vicio-900/50 dark:text-vicio-100'
                        : 'border-ink-200 text-ink-600 hover:border-vicio-300 dark:border-ink-700 dark:text-ink-300'}`}
                  >
                    <span
                      className={`grid h-3.5 w-3.5 place-items-center rounded border
                        ${ativa ? 'border-vicio-500 bg-vicio-500 text-white' : 'border-ink-300 dark:border-ink-600'}`}
                    >
                      {ativa && <Check size={10} strokeWidth={3} />}
                    </span>
                    {t.curso}
                    <span className="text-[10px] opacity-60">{(t.alunos || 0).toLocaleString('pt-BR')}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {valor.length > 1 && (
        <p className="flex items-center gap-1.5 text-[11px] text-ink-500 dark:text-ink-300">
          <Layers size={12} />
          {valor.length} turmas — quem entrou em qualquer uma conta como comprador.
        </p>
      )}
    </div>
  )
}
