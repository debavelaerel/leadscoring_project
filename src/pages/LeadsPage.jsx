import { useEffect, useState } from 'react'
import { Search, Download, UploadCloud, Flame, ThermometerSun, Snowflake, ChevronLeft, ChevronRight, Loader2, UserX } from 'lucide-react'
import { getLeads, urlExport } from '../lib/api.js'
import Dica from '../components/Dica.jsx'

/** Lista de leads com score — filtro por classe, busca e export pro comercial. */

const CLASSES = [
  { id: '', rotulo: 'Todos' },
  { id: 'hot', rotulo: 'Hot', icone: Flame, cor: 'text-accent-rose' },
  { id: 'warm', rotulo: 'Warm', icone: ThermometerSun, cor: 'text-accent-amber' },
  { id: 'cold', rotulo: 'Cold', icone: Snowflake, cor: 'text-accent-cyan' },
]

const POR_PAGINA = 50

function ChipClasse({ classe }) {
  const cfg = {
    hot: 'bg-accent-rose/15 text-accent-rose',
    warm: 'bg-accent-amber/15 text-amber-600 dark:text-accent-amber',
    cold: 'bg-accent-cyan/15 text-cyan-700 dark:text-accent-cyan',
  }[classe]
  return <span className={`chip ${cfg}`}>{classe}</span>
}

export default function LeadsPage({ analise, irParaUpload }) {
  const [classe, setClasse] = useState('hot')
  const [busca, setBusca] = useState('')
  const [buscaAplicada, setBuscaAplicada] = useState('')
  const [semCompradores, setSemCompradores] = useState(false)
  const [pagina, setPagina] = useState(1)
  const [dados, setDados] = useState(null)
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    if (!analise) return
    setCarregando(true)
    setErro(null)
    getLeads(analise.id, { classe: classe || undefined, busca: buscaAplicada || undefined, semCompradores, pagina, porPagina: POR_PAGINA })
      .then(setDados)
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false))
  }, [analise, classe, buscaAplicada, semCompradores, pagina])

  if (!analise) {
    return (
      <div className="grid min-h-[70vh] place-items-center px-4">
        <div className="card max-w-md px-8 py-10 text-center">
          <UploadCloud size={32} className="mx-auto text-vicio-400" />
          <p className="mt-4 font-display text-lg font-bold text-ink-900 dark:text-white">Nenhuma análise ainda</p>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">Suba o CSV da pesquisa para ver os leads pontuados.</p>
          <button className="btn-primary mx-auto mt-5" onClick={irParaUpload}>Nova análise</button>
        </div>
      </div>
    )
  }

  const totalPaginas = dados ? Math.max(Math.ceil(dados.total / POR_PAGINA), 1) : 1

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="section-title">Leads</p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink-900 dark:text-white">{analise.meta.nome}</h1>
        </div>
        <a href={urlExport(analise.id, classe || undefined, semCompradores)} className="btn-primary" download>
          <Download size={16} /> Exportar {classe ? classe : 'todos'}{semCompradores ? ' sem compradores' : ''} (CSV)
        </a>
      </div>

      {/* Filtros */}
      <div className="card mt-6 flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-1 rounded-xl bg-ink-100/70 p-1 dark:bg-ink-700/40">
          {CLASSES.map(({ id, rotulo, icone: Icone, cor }) => (
            <button
              key={id}
              onClick={() => { setClasse(id); setPagina(1) }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition
                ${classe === id ? 'bg-white text-ink-800 shadow-sm dark:bg-ink-800 dark:text-white' : 'text-ink-500 hover:text-ink-700 dark:text-ink-300 dark:hover:text-white'}`}
            >
              {Icone && <Icone size={14} className={cor} />}
              {rotulo}
            </button>
          ))}
        </div>
        <button
          onClick={() => { setSemCompradores((v) => !v); setPagina(1) }}
          title="Remove da lista (e do export) quem já consta como aluno da turma no banco"
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition
            ${semCompradores
              ? 'border-vicio-400 bg-vicio-600 text-white shadow-sm'
              : 'border-ink-200 text-ink-500 hover:bg-ink-100/70 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700/50'}`}
        >
          <UserX size={14} className={semCompradores ? 'text-accent-lime' : ''} />
          Ocultar quem já comprou
        </button>
        <form
          className="relative ml-auto"
          onSubmit={(e) => { e.preventDefault(); setBuscaAplicada(busca); setPagina(1) }}
        >
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            className="input !w-64 !pl-9"
            placeholder="Buscar por nome ou e-mail…"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </form>
      </div>

      {erro && <p className="mt-4 text-sm text-accent-rose">{erro}</p>}

      {/* Tabela */}
      <div className="card relative mt-4 overflow-hidden">
        <Dica texto="Leads ordenados por score (percentil 0–100 na lista, calculado pelos pesos das respostas). Classes: hot ≥ 80, warm 50–79, cold < 50. 'Comprou' indica match com aluno ativo da turma no banco — por e-mail exato ou telefone normalizado. O export CSV respeita o filtro de classe selecionado." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50/95 text-left text-xs uppercase tracking-wider text-ink-500 dark:bg-ink-800/95 dark:text-ink-300">
              <tr>
                <th className="px-5 py-3 font-semibold">Score</th>
                <th className="px-3 py-3 font-semibold">Lead</th>
                <th className="px-3 py-3 font-semibold">Telefone</th>
                <th className="px-3 py-3 font-semibold">Classe</th>
                <th className="px-3 py-3 font-semibold">Comprou</th>
                <th className="px-5 py-3 font-semibold">Cadastro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100/70 dark:divide-ink-700/50">
              {carregando && (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-ink-400">
                  <Loader2 size={18} className="mx-auto animate-spin" />
                </td></tr>
              )}
              {!carregando && dados?.leads?.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-ink-400">Nenhum lead encontrado.</td></tr>
              )}
              {!carregando && dados?.leads?.map((l) => (
                <tr key={l.idx} className="hover:bg-vicio-50/40 dark:hover:bg-vicio-900/20">
                  <td className="px-5 py-2.5">
                    <span className="font-display text-base font-bold tabular-nums text-ink-900 dark:text-white">{l.score}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="max-w-[16rem] truncate font-medium text-ink-800 dark:text-ink-100">{l.nome || '—'}</p>
                    <p className="max-w-[16rem] truncate text-xs text-ink-500 dark:text-ink-300">{l.email || 'sem e-mail'}</p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums text-ink-600 dark:text-ink-200">{l.telefone_fmt || '—'}</td>
                  <td className="px-3 py-2.5"><ChipClasse classe={l.classe} /></td>
                  <td className="px-3 py-2.5">
                    {l.comprou
                      ? <span className="chip bg-accent-lime/15 text-lime-700 dark:text-accent-lime">sim · {l.match_via}</span>
                      : <span className="text-xs text-ink-400">não</span>}
                  </td>
                  <td className="whitespace-nowrap px-5 py-2.5 text-xs text-ink-500 dark:text-ink-300">
                    {(l.data || '').slice(0, 10) || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Paginação */}
        <div className="flex items-center justify-between border-t border-ink-100/70 px-5 py-3 text-sm dark:border-ink-700/60">
          <p className="text-xs text-ink-500 dark:text-ink-300">
            {dados ? `${dados.total.toLocaleString('pt-BR')} leads` : '—'}
          </p>
          <div className="flex items-center gap-2">
            <button className="btn-ghost !px-2" disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs tabular-nums text-ink-600 dark:text-ink-200">{pagina} / {totalPaginas}</span>
            <button className="btn-ghost !px-2" disabled={pagina >= totalPaginas} onClick={() => setPagina((p) => p + 1)}>
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
