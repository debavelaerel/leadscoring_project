import { useEffect, useMemo, useState } from 'react'
import {
  Database, FileSpreadsheet, Loader2, Play, Trash2, RefreshCw,
  AlertTriangle, CheckCircle2, Clock, HardDriveDownload, Download,
} from 'lucide-react'
import { getDatasets, apagarDataset, getTurmas, criarAnalise, getAnalise, urlArquivoOriginal } from '../lib/api.js'
import SeletorTurmas from '../components/SeletorTurmas.jsx'

/**
 * Bases — o que já foi para o banco.
 *
 * Cada linha é um CSV de pesquisa que subiu: arquivo bruto guardado no Storage
 * e leads normalizados na tabela. Daqui dá pra rodar uma análise nova sobre a
 * base (escolhendo a turma) ou reabrir uma análise que já rodou.
 */

const fmtBytes = (b) => {
  if (!b) return '—'
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

const fmtData = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
    ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

const fmtNum = (n) => (n ?? 0).toLocaleString('pt-BR')

const SELOS = {
  pronto:   { icone: CheckCircle2,   classe: 'bg-accent-lime/15 text-lime-700 dark:text-accent-lime', label: 'no banco' },
  enviando: { icone: Clock,          classe: 'bg-accent-amber/15 text-amber-700 dark:text-accent-amber', label: 'enviando' },
  erro:     { icone: AlertTriangle,  classe: 'bg-accent-rose/15 text-accent-rose', label: 'erro' },
}

export default function DatasetsPage({ onAbrirAnalise, irParaUpload }) {
  const [datasets, setDatasets] = useState([])
  const [turmas, setTurmas] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [turmaPorBase, setTurmaPorBase] = useState({}) // { [datasetId]: ["47|90D", ...] }
  const [aberta, setAberta] = useState(null)           // base com o seletor aberto
  const [ocupado, setOcupado] = useState(null)         // id da base em processamento

  const carregar = async () => {
    setCarregando(true)
    setErro(null)
    try {
      const r = await getDatasets()
      setDatasets(r.datasets || [])
      setTurmaPorBase((atual) => {
        const novo = { ...atual }
        for (const d of r.datasets || []) {
          if (!novo[d.id]?.length && d.oab && d.curso) novo[d.id] = [`${d.oab}|${d.curso}`]
        }
        return novo
      })
    } catch (e) {
      setErro(e.message)
    } finally {
      setCarregando(false)
    }
  }

  useEffect(() => {
    carregar()
    getTurmas().then((r) => setTurmas(r.turmas || [])).catch(() => {})
  }, [])

  const totais = useMemo(() => ({
    bases: datasets.length,
    leads: datasets.reduce((s, d) => s + (d.total_linhas || 0), 0),
    analises: datasets.reduce((s, d) => s + (d.analises?.length || 0), 0),
  }), [datasets])

  const analisar = async (dataset) => {
    const sel = turmaPorBase[dataset.id] || []
    if (!sel.length) { setErro('Marque ao menos uma turma para cruzar os compradores.'); return }
    const turmasEscolhidas = sel.map((k) => {
      const [oab, ...resto] = k.split('|')
      return { oab: Number(oab), curso: resto.join('|') }
    })
    setOcupado(dataset.id)
    setErro(null)
    try {
      const resultado = await criarAnalise({
        dataset_id: dataset.id,
        turmas: turmasEscolhidas,
        nome: `${dataset.nome} · OAB ${turmasEscolhidas[0].oab}${turmasEscolhidas.length > 1 ? ` (${turmasEscolhidas.length} turmas)` : ` ${turmasEscolhidas[0].curso}`}`,
      })
      onAbrirAnalise(resultado)
    } catch (e) {
      setErro(e.message)
    } finally {
      setOcupado(null)
    }
  }

  const abrir = async (analiseId) => {
    setOcupado(analiseId)
    try {
      const r = await getAnalise(analiseId)
      onAbrirAnalise({ id: analiseId, ...r })
    } catch (e) {
      setErro(e.message)
    } finally {
      setOcupado(null)
    }
  }

  const apagar = async (dataset) => {
    if (!window.confirm(`Apagar "${dataset.nome}" e todos os leads dela do banco?`)) return
    setOcupado(dataset.id)
    try {
      await apagarDataset(dataset.id)
      await carregar()
    } catch (e) {
      setErro(e.message)
    } finally {
      setOcupado(null)
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="section-title">Bases</p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink-900 dark:text-white">
            O que já está no banco
          </h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
            Cada base é um CSV de pesquisa já enviado. O arquivo bruto fica guardado e os leads
            normalizados ficam disponíveis para cruzar com qualquer turma.
          </p>
        </div>
        <button className="btn-ghost" onClick={carregar} disabled={carregando}>
          {carregando ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Atualizar
        </button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Bases enviadas', valor: fmtNum(totais.bases), icone: Database },
          { label: 'Leads no banco', valor: fmtNum(totais.leads), icone: HardDriveDownload },
          { label: 'Análises rodadas', valor: fmtNum(totais.analises), icone: Play },
        ].map(({ label, valor, icone: Icone }) => (
          <div key={label} className="card flex items-center gap-3 px-4 py-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-vicio text-white">
              <Icone size={16} />
            </span>
            <div>
              <p className="text-xs text-ink-500 dark:text-ink-300">{label}</p>
              <p className="font-display text-lg font-bold text-ink-900 dark:text-white">{valor}</p>
            </div>
          </div>
        ))}
      </div>

      {erro && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-accent-rose/40 bg-accent-rose/10 px-4 py-3 text-sm text-accent-rose">
          <AlertTriangle size={16} className="shrink-0" /> {erro}
        </div>
      )}

      {!carregando && datasets.length === 0 && (
        <div className="card mt-6 grid place-items-center px-6 py-14 text-center">
          <FileSpreadsheet size={30} className="text-ink-300 dark:text-ink-600" />
          <p className="mt-3 text-sm font-semibold text-ink-800 dark:text-white">Nenhuma base ainda</p>
          <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">
            Suba o primeiro CSV de pesquisa para começar a acumular dados.
          </p>
          <button className="btn-primary mt-4" onClick={irParaUpload}>Enviar CSV</button>
        </div>
      )}

      <div className="mt-6 space-y-3">
        {datasets.map((d) => {
          const selo = SELOS[d.status] || SELOS.enviando
          const Icone = selo.icone
          const processando = ocupado === d.id
          return (
            <div key={d.id} className="card px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <FileSpreadsheet size={16} className="shrink-0 text-vicio-500" />
                    <p className="truncate font-semibold text-ink-900 dark:text-white" title={d.nome}>{d.nome}</p>
                    <span className={`chip ${selo.classe}`}>
                      <Icone size={12} /> {selo.label}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">
                    {fmtNum(d.total_linhas)} leads · {d.perguntas} perguntas · {fmtBytes(d.bytes)} · {fmtData(d.criado_em)}
                    {d.oab ? ` · sugerida: OAB ${d.oab} — ${d.curso}` : ''}
                  </p>
                  {d.analises?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {d.analises.slice(0, 4).map((a) => (
                        <button
                          key={a.id}
                          onClick={() => abrir(a.id)}
                          className="chip bg-ink-100 text-ink-600 transition hover:bg-vicio-100 hover:text-vicio-800 dark:bg-ink-700/60 dark:text-ink-200 dark:hover:bg-vicio-900/60"
                          title="Reabrir esta análise"
                        >
                          {a.nome || 'análise'} · {fmtData(a.criada_em)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="btn-ghost !py-2"
                    onClick={() => setAberta(aberta === d.id ? null : d.id)}
                  >
                    {(turmaPorBase[d.id] || []).length
                      ? `${(turmaPorBase[d.id] || []).length} turma(s)`
                      : 'Escolher turmas'}
                  </button>
                  <button
                    className="btn-primary !py-2"
                    disabled={processando || d.status !== 'pronto'}
                    onClick={() => analisar(d)}
                  >
                    {processando ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                    Analisar
                  </button>
                  {d.tem_arquivo && (
                    <a
                      className="btn-ghost !px-2"
                      href={urlArquivoOriginal(d.id)}
                      title="Baixar o CSV original"
                    >
                      <Download size={15} />
                    </a>
                  )}
                  <button
                    className="btn-ghost !px-2 text-accent-rose"
                    title="Apagar base"
                    disabled={processando}
                    onClick={() => apagar(d)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {aberta === d.id && (
                <div className="mt-4 rounded-xl border border-ink-100 bg-ink-50/60 p-4 dark:border-ink-700/60 dark:bg-ink-800/40">
                  <SeletorTurmas
                    turmas={turmas}
                    valor={turmaPorBase[d.id] || []}
                    onChange={(v) => setTurmaPorBase((t) => ({ ...t, [d.id]: v }))}
                    compacto
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
