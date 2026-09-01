import { useEffect, useMemo, useState } from 'react'
import {
  Boxes, Loader2, AlertTriangle, Check, Download, RefreshCw, Target, TrendingUp,
} from 'lucide-react'
import { getDatasets, getModelos, criarModelo, urlPesosModelo } from '../lib/api.js'

/**
 * Modelo combinado.
 *
 * Empilha duas ou mais bases pra cada célula (pergunta × resposta) ganhar
 * amostra. O peso é a média ponderada do log-lift calculado DENTRO de cada
 * base — somar contagens cruas de lançamentos com taxas diferentes criaria
 * sinal falso.
 *
 * Com 2+ bases também dá pra medir acurácia de verdade: treina sem uma base e
 * pontua ela. É a diferença entre "o modelo separa bem" e "o modelo decorou".
 */

const fmtNum = (n) => (n ?? 0).toLocaleString('pt-BR')
const fmtPct = (x) => `${((x || 0) * 100).toFixed(1)}%`
const fmtData = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—')

function Metrica({ label, valor, ajuda, destaque = false }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${destaque
      ? 'border-vicio-300 bg-vicio-50/60 dark:border-vicio-600/50 dark:bg-vicio-900/30'
      : 'border-ink-100 dark:border-ink-700/60'}`}>
      <p className="text-[11px] text-ink-500 dark:text-ink-300">{label}</p>
      <p className="font-display text-lg font-bold text-ink-900 dark:text-white">{valor}</p>
      {ajuda && <p className="mt-0.5 text-[10px] leading-tight text-ink-400 dark:text-ink-400">{ajuda}</p>}
    </div>
  )
}

export default function ModeloPage({ irParaBases }) {
  const [datasets, setDatasets] = useState([])
  const [modelos, setModelos] = useState([])
  const [sel, setSel] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [treinando, setTreinando] = useState(false)
  const [erro, setErro] = useState(null)
  const [resultado, setResultado] = useState(null)

  const carregar = async () => {
    setCarregando(true)
    try {
      const [d, m] = await Promise.all([getDatasets(), getModelos().catch(() => ({ modelos: [] }))])
      setDatasets((d.datasets || []).filter((x) => x.status === 'pronto'))
      setModelos(m.modelos || [])
    } catch (e) {
      setErro(e.message)
    } finally {
      setCarregando(false)
    }
  }

  useEffect(() => { carregar() }, [])

  const analisadas = useMemo(
    () => new Set(datasets.filter((d) => (d.analises?.length || 0) > 0).map((d) => d.id)),
    [datasets],
  )

  const treinar = async () => {
    if (sel.length < 1) return
    setTreinando(true)
    setErro(null)
    setResultado(null)
    try {
      const r = await criarModelo({ datasets: sel })
      setResultado(r)
      carregar()
    } catch (e) {
      setErro(e.message)
    } finally {
      setTreinando(false)
    }
  }

  const validacao = resultado?.validacao || []
  const temForaDaAmostra = validacao.some((v) => v.fora_da_amostra)

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-8">
      <p className="section-title">Modelo</p>
      <h1 className="mt-1 font-display text-2xl font-bold text-ink-900 dark:text-white">
        Combinar bases para ganhar acurácia
      </h1>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
        Cada lançamento sozinho dá poucas compras por resposta. Empilhando edições, cada célula
        ganha amostra — e com duas ou mais bases dá pra medir a acurácia fora da amostra, treinando
        sem uma base e pontuando ela.
      </p>

      {/* seleção de bases */}
      <div className="card mt-6 px-5 py-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink-800 dark:text-white">Bases do treino</p>
          <button className="btn-ghost !py-1.5" onClick={carregar} disabled={carregando}>
            {carregando ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Atualizar
          </button>
        </div>

        {!carregando && datasets.length === 0 && (
          <p className="mt-3 text-sm text-ink-500 dark:text-ink-300">
            Nenhuma base pronta ainda.{' '}
            <button className="text-vicio-600 hover:underline dark:text-accent-lime" onClick={irParaBases}>
              Ver bases
            </button>
          </p>
        )}

        <div className="mt-3 space-y-2">
          {datasets.map((d) => {
            const marcada = sel.includes(d.id)
            const cruzada = analisadas.has(d.id)
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setSel(marcada ? sel.filter((x) => x !== d.id) : [...sel, d.id])}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition
                  ${marcada
                    ? 'border-vicio-400 bg-vicio-50/70 dark:border-vicio-500 dark:bg-vicio-900/40'
                    : 'border-ink-100 hover:border-vicio-300 dark:border-ink-700/60'}`}
              >
                <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border
                  ${marcada ? 'border-vicio-500 bg-vicio-500 text-white' : 'border-ink-300 dark:border-ink-600'}`}>
                  {marcada && <Check size={11} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink-800 dark:text-ink-100">{d.nome}</span>
                  <span className="block text-xs text-ink-500 dark:text-ink-300">
                    {fmtNum(d.total_linhas)} leads · {d.perguntas} perguntas
                    {d.oab ? ` · OAB ${d.oab}` : ''}
                  </span>
                </span>
                {!cruzada && (
                  <span className="chip bg-accent-amber/15 text-amber-700 dark:text-accent-amber">
                    sem análise
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {sel.length === 1 && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-500 dark:text-ink-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-accent-amber" />
            Com uma base só não dá para medir acurácia fora da amostra — todo número sai in-sample.
            Marque uma segunda base para o modelo ser validado de verdade.
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <button className="btn-primary !px-5" disabled={!sel.length || treinando} onClick={treinar}>
            {treinando ? <Loader2 size={15} className="animate-spin" /> : <Boxes size={15} />}
            {treinando ? 'Treinando…' : `Treinar com ${sel.length || 0} base(s)`}
          </button>
        </div>
      </div>

      {erro && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-accent-rose/40 bg-accent-rose/10 px-4 py-3 text-sm text-accent-rose">
          <AlertTriangle size={16} className="shrink-0" /> {erro}
        </div>
      )}

      {/* resultado */}
      {resultado && (
        <>
          <div className="card mt-6 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink-800 dark:text-white">{resultado.nome}</p>
                <p className="text-xs text-ink-500 dark:text-ink-300">
                  {fmtNum(resultado.stats.total_leads)} leads · {fmtNum(resultado.stats.total_compras)} compras ·
                  taxa base {fmtPct(resultado.stats.taxa_base)} · {resultado.stats.perguntas.length} perguntas no modelo
                </p>
              </div>
              <a className="btn-ghost" href={urlPesosModelo(resultado.id)}>
                <Download size={15} /> Pesos (JSON)
              </a>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {(resultado.stats.bases || []).map((b) => (
                <div key={b.dataset_id} className="rounded-xl border border-ink-100 px-3 py-2 dark:border-ink-700/60">
                  <p className="truncate text-xs font-medium text-ink-700 dark:text-ink-200" title={b.nome}>{b.nome}</p>
                  <p className="text-[11px] text-ink-500 dark:text-ink-300">
                    {fmtNum(b.leads)} leads · {fmtPct(b.taxa_base)} de conversão
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* validação */}
          <div className="card mt-4 px-5 py-4">
            <div className="flex items-center gap-2">
              <Target size={16} className="text-vicio-500" />
              <p className="text-sm font-semibold text-ink-800 dark:text-white">Acurácia</p>
            </div>
            <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">
              {temForaDaAmostra
                ? 'Cada base foi pontuada por um modelo treinado SEM ela. É esse número que vale — o "dentro da amostra" sempre parece melhor do que a realidade.'
                : 'Só há uma base, então tudo aqui é dentro da amostra (o modelo já viu esses dados). Serve de referência, não de previsão.'}
            </p>

            <div className="mt-4 space-y-4">
              {validacao.map((v) => {
                const alvo = v.fora_da_amostra || v.dentro_da_amostra || {}
                const dentro = v.dentro_da_amostra || {}
                return (
                  <div key={v.dataset_id}>
                    <p className="text-xs font-semibold text-ink-700 dark:text-ink-200">{v.base}</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      <Metrica
                        destaque
                        label="AUC"
                        valor={alvo.auc == null ? '—' : Number(alvo.auc).toFixed(3)}
                        ajuda={`0,5 = aleatório${v.fora_da_amostra && dentro.auc != null ? ` · in-sample ${Number(dentro.auc).toFixed(3)}` : ''}`}
                      />
                      <Metrica
                        destaque
                        label="Lift dos hot"
                        valor={`${Number(alvo.lift_hot || 0).toFixed(2)}×`}
                        ajuda={`${fmtPct(alvo.taxa_hot)} vs ${fmtPct(alvo.taxa_base)} da lista`}
                      />
                      <Metrica
                        label="Captura dos hot"
                        valor={fmtPct(alvo.captura_hot)}
                        ajuda={`das compras, com ${fmtPct(alvo.fatia_hot)} da lista`}
                      />
                      <Metrica
                        label="Lift do decil topo"
                        valor={`${Number(alvo.lift_decil_topo || 0).toFixed(2)}×`}
                        ajuda={`${fmtNum(alvo.compras)} compras em ${fmtNum(alvo.leads)} leads`}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* impulsionadores do modelo combinado */}
          <div className="card mt-4 px-5 py-4">
            <div className="flex items-center gap-2">
              <TrendingUp size={16} className="text-vicio-500" />
              <p className="text-sm font-semibold text-ink-800 dark:text-white">
                O que mais puxa a conversão (combinado)
              </p>
            </div>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {['positivos', 'negativos'].map((lado) => (
                <div key={lado}>
                  <p className="mb-2 text-xs uppercase tracking-wider text-ink-500 dark:text-ink-300">
                    {lado === 'positivos' ? 'Puxam para cima' : 'Puxam para baixo'}
                  </p>
                  <div className="space-y-1.5">
                    {(resultado.stats.impulsionadores?.[lado] || []).map((i, k) => (
                      <div key={k} className="flex items-center justify-between gap-2 rounded-lg border border-ink-100 px-3 py-1.5 dark:border-ink-700/60">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-ink-800 dark:text-ink-100" title={i.resposta}>
                            {i.resposta}
                          </p>
                          <p className="truncate text-[10px] text-ink-400" title={i.pergunta}>{i.pergunta}</p>
                        </div>
                        <span className={`shrink-0 text-xs font-bold ${
                          lado === 'positivos' ? 'text-lime-600 dark:text-accent-lime' : 'text-accent-rose'
                        }`}>
                          {Number(i.lift).toFixed(2)}×
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* histórico */}
      {modelos.length > 0 && (
        <div className="card mt-6 px-5 py-4">
          <p className="text-sm font-semibold text-ink-800 dark:text-white">Modelos treinados</p>
          <div className="mt-2 divide-y divide-ink-100 dark:divide-ink-700/50">
            {modelos.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-ink-800 dark:text-ink-100">{m.nome}</p>
                  <p className="text-[11px] text-ink-500 dark:text-ink-300">
                    {fmtNum(m.total_leads)} leads · {m.datasets?.length || 0} base(s) · {fmtData(m.criado_em)}
                  </p>
                </div>
                <a className="btn-ghost !px-2 !py-1" href={urlPesosModelo(m.id)} title="Baixar pesos">
                  <Download size={14} />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
