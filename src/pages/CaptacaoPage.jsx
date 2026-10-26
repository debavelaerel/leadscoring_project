import { useEffect, useMemo, useState } from 'react'
import { Radar, Loader2, AlertTriangle, Download, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { getDatasets, getModelos, pontuarCaptacao, urlExportModelo } from '../lib/api.js'

/**
 * Captação em andamento.
 *
 * Pontua uma lista de leads (sem precisar de compradores) com um modelo já
 * treinado e mostra a qualidade da captação. A nota é ABSOLUTA: mede cada lead
 * contra os leads de treino do modelo, então 50 = lead típico do histórico e
 * uma base com nota média acima de 50 está captando acima do histórico.
 * (O percentil dentro da própria base daria sempre 20% de hot.)
 */

const fmtNum = (n) => (n ?? 0).toLocaleString('pt-BR')
const fmtPct = (x, d = 1) => `${((x || 0) * 100).toFixed(d)}%`
const fmtDia = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : 'sem data')

const VEREDITO = {
  acima: { titulo: 'Captação acima do histórico', cor: 'border-emerald-400/50 bg-emerald-50 dark:bg-emerald-900/20', icone: TrendingUp },
  em_linha: { titulo: 'Captação em linha com o histórico', cor: 'border-ink-200 bg-ink-50 dark:border-ink-700 dark:bg-ink-800/60', icone: Minus },
  abaixo: { titulo: 'Captação abaixo do histórico', cor: 'border-accent-amber/50 bg-accent-amber/10', icone: TrendingDown },
  indefinido: { titulo: 'Sem base de comparação', cor: 'border-ink-200 bg-ink-50 dark:border-ink-700 dark:bg-ink-800/60', icone: Minus },
}

function Metrica({ label, valor, ajuda, destaque = false }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${destaque
      ? 'border-vicio-300 bg-vicio-50/60 dark:border-vicio-600/50 dark:bg-vicio-900/30'
      : 'border-ink-100 dark:border-ink-700/60'}`}>
      <p className="text-[11px] text-ink-500 dark:text-ink-300">{label}</p>
      <p className="font-display text-xl font-bold text-ink-900 dark:text-white">{valor}</p>
      {ajuda && <p className="mt-0.5 text-[10px] leading-tight text-ink-400">{ajuda}</p>}
    </div>
  )
}

function Barra({ pct, cor = 'bg-gradient-vicio' }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100 dark:bg-ink-700">
      <div className={`h-full rounded-full ${cor}`} style={{ width: `${Math.max(1, Math.min(100, pct))}%` }} />
    </div>
  )
}

export default function CaptacaoPage({ baseInicial, irParaUpload }) {
  const [datasets, setDatasets] = useState([])
  const [modelos, setModelos] = useState([])
  const [baseId, setBaseId] = useState(baseInicial || '')
  const [modeloId, setModeloId] = useState('')
  const [carregando, setCarregando] = useState(true)
  const [pontuando, setPontuando] = useState(false)
  const [erro, setErro] = useState(null)
  const [painel, setPainel] = useState(null)
  const [dimAba, setDimAba] = useState(0)
  const [taxaObservada, setTaxaObservada] = useState('')

  const carregar = async () => {
    setCarregando(true)
    try {
      const [d, m] = await Promise.all([getDatasets(), getModelos().catch(() => ({ modelos: [] }))])
      const bases = (d.datasets || []).filter((x) => x.status === 'pronto')
      const ms = m.modelos || []
      setDatasets(bases)
      setModelos(ms)
      setModeloId((atual) => atual || ms[0]?.id || '')
      setBaseId((atual) => atual || bases[0]?.id || '')
    } catch (e) {
      setErro(e.message)
    } finally {
      setCarregando(false)
    }
  }

  useEffect(() => { carregar() }, [])

  const pontuar = async (b = baseId, m = modeloId) => {
    if (!b || !m || pontuando) return
    setPontuando(true)
    setErro(null)
    try {
      const alvo = Number(String(taxaObservada).replace(',', '.')) / 100
      setPainel(await pontuarCaptacao({ modelo_id: m, dataset_id: b, taxa_alvo: alvo > 0 && alvo < 1 ? alvo : undefined }))
    } catch (e) {
      setPainel(null)
      setErro(e.message)
    } finally {
      setPontuando(false)
    }
  }

  // veio do upload ("só pontuar"): já abre pontuado
  useEffect(() => {
    if (baseInicial && modeloId && !painel && !pontuando) {
      setBaseId(baseInicial)
      pontuar(baseInicial, modeloId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseInicial, modeloId])

  const v = painel ? VEREDITO[painel.comparacao.veredito] || VEREDITO.indefinido : null
  const maxDia = useMemo(() => Math.max(0.0001, ...(painel?.por_dia || []).map((d) => d.prob_media)), [painel])
  const maxFaixa = useMemo(() => Math.max(1, ...(painel?.faixas || []).map((f) => f.leads)), [painel])
  const maxOrigem = useMemo(() => Math.max(0.0001, ...(painel?.por_origem || []).map((o) => o.prob_media)), [painel])

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-8">
      <p className="section-title">Captação</p>
      <h1 className="mt-1 font-display text-2xl font-bold text-ink-900 dark:text-white">
        Nota e qualidade da captação
      </h1>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
        Pontue uma lista de leads com um modelo já treinado — não precisa de compradores. A nota
        compara cada lead com o histórico do modelo: 50 é um lead típico, e quanto mais acima, melhor.
      </p>

      <div className="card mt-6 px-5 py-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink-800 dark:text-white">O que pontuar</p>
          <button className="btn-ghost !py-1.5" onClick={carregar} disabled={carregando}>
            {carregando ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Atualizar
          </button>
        </div>

        {!carregando && modelos.length === 0 && (
          <p className="mt-3 text-sm text-ink-500 dark:text-ink-300">
            Nenhum modelo treinado ainda. Treine um na tela Modelo, com bases que já têm compradores.
          </p>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-500 dark:text-ink-300">
            Lista de leads
            <select className="input mt-1" value={baseId} onChange={(e) => setBaseId(e.target.value)}>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>{d.nome} · {fmtNum(d.total_linhas)} leads</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-500 dark:text-ink-300">
            Modelo
            <select className="input mt-1" value={modeloId} onChange={(e) => setModeloId(e.target.value)}>
              {modelos.map((m) => (
                <option key={m.id} value={m.id}>{m.nome}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-3 block text-xs text-ink-500 dark:text-ink-300">
          Conversão já observada nesta captação, em % (opcional)
          <input className="input mt-1 max-w-[12rem]" type="number" min="0.1" max="99" step="0.1" value={taxaObservada}
            onChange={(e) => setTaxaObservada(e.target.value)} placeholder="ex.: 10,7" />
          <span className="mt-1 block text-[10px] text-ink-400">
            Ajusta o nível da chance de compra à taxa real do lançamento. A ordem dos leads e a nota não mudam.
          </span>
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" onClick={() => pontuar()} disabled={!baseId || !modeloId || pontuando}>
            {pontuando ? <Loader2 size={16} className="animate-spin" /> : <Radar size={16} />}
            {pontuando ? 'Pontuando…' : 'Pontuar captação'}
          </button>
          <button className="btn-ghost" onClick={irParaUpload}>Enviar uma lista nova</button>
        </div>
      </div>

      {erro && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm text-ink-700 dark:text-ink-100">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-accent-amber" />
          <span>{erro}</span>
        </div>
      )}

      {painel && v && (
        <>
          {/* veredito */}
          <div className={`mt-6 flex items-start gap-3 rounded-2xl border px-5 py-4 ${v.cor}`}>
            <v.icone size={22} className="mt-0.5 shrink-0 text-vicio-600 dark:text-accent-lime" />
            <div>
              <p className="font-display text-lg font-bold text-ink-900 dark:text-white">
                {v.titulo}
                {painel.comparacao.razao != null && (
                  <span className="ml-2 text-sm font-semibold text-ink-500 dark:text-ink-300">
                    ({painel.comparacao.razao.toLocaleString('pt-BR')}× o histórico)
                  </span>
                )}
              </p>
              <p className="mt-1 text-sm text-ink-600 dark:text-ink-200">
                {painel.base.nome}: chance média de compra de <b>{fmtPct(painel.resumo.prob_media)}</b> por lead, contra{' '}
                <b>{fmtPct(painel.comparacao.prob_media_historico)}</b> nas bases de treino do modelo
                ({painel.comparacao.bases_treino.map((b) => b.nome).join(' e ')}). Abaixo de 0,9× é sinal de
                alerta; acima de 1,1×, captação acima do normal.
              </p>
            </div>
          </div>

          {/* números */}
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Metrica destaque label="Nota média (0–100)" valor={painel.resumo.score_medio}
              ajuda="50 = lead típico do histórico" />
            <Metrica destaque label="Leads hot" valor={fmtPct(painel.resumo.pct_hot)}
              ajuda={`histórico: ${fmtPct(painel.resumo.pct_hot_historico, 0)} · ${fmtNum(painel.resumo.classes.hot)} leads`} />
            <Metrica label="Compras esperadas entre estes leads" valor={`≈ ${fmtNum(painel.resumo.compras_esperadas)}`}
              ajuda={[
                painel.resumo.calibracao
                  ? `calibrado à taxa observada de ${fmtPct(painel.resumo.calibracao.taxa_alvo)} (sem calibrar: ${fmtPct(painel.resumo.calibracao.prob_media_antes)}).`
                  : painel.resumo.compras_faixa_historica
                    ? `faixa esperada (95%): ${fmtNum(painel.resumo.compras_faixa_historica[0])} a ${fmtNum(painel.resumo.compras_faixa_historica[1])} (conversão de ${fmtPct(painel.resumo.conversao_faixa_historica[0])} a ${fmtPct(painel.resumo.conversao_faixa_historica[1])}).`
                    : null,
                painel.resumo.vendas_totais_faixa
                  ? `Só quem está na lista; vendas totais entre ${fmtNum(painel.resumo.vendas_totais_faixa[0])} e ${fmtNum(painel.resumo.vendas_totais_faixa[1])}, porque a cobertura da lista variou de lançamento para lançamento.`
                  : 'Só quem está na lista; vendas por outros caminhos ficam de fora.',
              ].filter(Boolean).join(' ')} />
            <Metrica label="Responderam a pesquisa" valor={fmtPct(painel.resumo.pct_responderam, 0)}
              ajuda="quem não responde compra bem menos" />
          </div>

          {/* classes + faixas */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="card px-5 py-4">
              <p className="text-sm font-semibold text-ink-800 dark:text-white">Classes</p>
              <div className="mt-3 space-y-3">
                {[['hot', 'Hot (nota ≥ 80)', 'bg-emerald-500'], ['warm', 'Warm (50–79)', 'bg-accent-amber'], ['cold', 'Cold (< 50)', 'bg-ink-300']].map(([k, nome, cor]) => (
                  <div key={k}>
                    <div className="flex justify-between text-xs text-ink-600 dark:text-ink-200">
                      <span>{nome}</span>
                      <span>{fmtNum(painel.resumo.classes[k])} · {fmtPct(painel.resumo.classes[k] / painel.resumo.leads, 0)}</span>
                    </div>
                    <Barra pct={(painel.resumo.classes[k] / painel.resumo.leads) * 100} cor={cor} />
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-ink-400">
                No histórico a distribuição é 20% hot, 30% warm e 50% cold.
              </p>
            </div>

            <div className="card px-5 py-4">
              <p className="text-sm font-semibold text-ink-800 dark:text-white">Leads por faixa de nota</p>
              <div className="mt-3 flex h-28 items-end gap-1.5">
                {painel.faixas.map((f) => (
                  <div key={f.faixa} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${f.faixa}: ${fmtNum(f.leads)} leads · chance ${fmtPct(f.prob_media)}`}>
                    <div className="w-full rounded-t bg-gradient-vicio" style={{ height: `${Math.max(3, (f.leads / maxFaixa) * 100)}%` }} />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex gap-1.5 text-[9px] text-ink-400">
                {painel.faixas.map((f) => <span key={f.faixa} className="flex-1 text-center">{f.faixa.split('–')[0]}</span>)}
              </div>
            </div>
          </div>

          {/* origem */}
          {painel.por_origem.length > 0 && (
            <div className="card mt-4 px-5 py-4">
              <p className="text-sm font-semibold text-ink-800 dark:text-white">Qualidade por origem do lead</p>
              <p className="text-xs text-ink-500 dark:text-ink-300">Onde a captação está trazendo leads melhores ou piores.</p>
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="py-1 font-medium">Origem</th>
                    <th className="py-1 text-right font-medium">Leads</th>
                    <th className="py-1 text-right font-medium">Nota</th>
                    <th className="py-1 text-right font-medium">% hot</th>
                    <th className="py-1 text-right font-medium" title="Taxa real de compra dessa origem nas bases de treino">Histórico</th>
                    <th className="w-1/3 py-1 pl-4 font-medium">Chance de compra</th>
                  </tr>
                </thead>
                <tbody>
                  {painel.por_origem.map((o) => (
                    <tr key={o.origem} className="border-t border-ink-100 dark:border-ink-700/60">
                      <td className="py-1.5 text-ink-800 dark:text-white">{o.origem}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtNum(o.leads)}</td>
                      <td className="py-1.5 text-right tabular-nums">{o.score_medio}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtPct(o.pct_hot, 0)}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink-500 dark:text-ink-300">
                        {o.taxa_historica == null ? '—' : fmtPct(o.taxa_historica)}
                      </td>
                      <td className="py-1.5 pl-4">
                        <div className="flex items-center gap-2">
                          <Barra pct={(o.prob_media / maxOrigem) * 100} />
                          <span className="w-12 text-right text-xs tabular-nums">{fmtPct(o.prob_media)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* campanha, criativo, público */}
          {painel.por_dimensao?.length > 0 && (() => {
            const dim = painel.por_dimensao[Math.min(dimAba, painel.por_dimensao.length - 1)]
            const max = Math.max(0.0001, ...dim.itens.map((i) => i.prob_media))
            return (
              <div className="card mt-4 px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink-800 dark:text-white">Campanha, criativo e público</p>
                    <p className="text-xs text-ink-500 dark:text-ink-300">Quais anúncios estão trazendo leads melhores ou piores (mínimo de 30 leads).</p>
                  </div>
                  <div className="inline-flex rounded-lg bg-ink-100 p-0.5 dark:bg-ink-800">
                    {painel.por_dimensao.map((x, i) => (
                      <button key={x.chave} onClick={() => setDimAba(i)}
                        className={`rounded-md px-3 py-1 text-xs font-medium ${dimAba === i ? 'bg-white text-ink-800 shadow-sm dark:bg-ink-700 dark:text-white' : 'text-ink-500 dark:text-ink-300'}`}>
                        {x.titulo}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-ink-400">
                        <th className="py-1 font-medium">{dim.titulo}</th>
                        <th className="py-1 text-right font-medium">Leads</th>
                        <th className="py-1 text-right font-medium">Nota</th>
                        <th className="py-1 text-right font-medium">% hot</th>
                        <th className="w-1/3 py-1 pl-4 font-medium">Chance de compra</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dim.itens.map((i) => (
                        <tr key={i.valor} className="border-t border-ink-100 dark:border-ink-700/60">
                          <td className="max-w-[16rem] truncate py-1.5 text-ink-800 dark:text-white" title={i.valor}>{i.valor}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtNum(i.leads)}</td>
                          <td className="py-1.5 text-right tabular-nums">{i.score_medio}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtPct(i.pct_hot, 0)}</td>
                          <td className="py-1.5 pl-4">
                            <div className="flex items-center gap-2">
                              <Barra pct={(i.prob_media / max) * 100} />
                              <span className="w-12 text-right text-xs tabular-nums">{fmtPct(i.prob_media)}</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}

          {/* perfil do público */}
          {painel.perfil?.length > 0 && (
            <div className="card mt-4 px-5 py-4">
              <p className="text-sm font-semibold text-ink-800 dark:text-white">Perfil do público vs. histórico</p>
              <p className="text-xs text-ink-500 dark:text-ink-300">
                Quem está entrando nesta captação. Barra cheia = esta lista; traço = média das bases de treino.
                A chance mostra o quanto cada resposta vale no modelo.
              </p>
              <div className="mt-4 grid gap-6 lg:grid-cols-2">
                {painel.perfil.map((q) => (
                  <div key={q.pergunta}>
                    <p className="text-xs font-semibold text-ink-700 dark:text-ink-100">{q.pergunta}</p>
                    <div className="mt-2 space-y-1.5">
                      {q.respostas.map((r) => {
                        const dif = r.pct_historico == null ? null : (r.pct - r.pct_historico) * 100
                        return (
                          <div key={r.resposta} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs">
                            <span className="truncate text-ink-600 dark:text-ink-200" title={r.resposta}>{r.resposta}</span>
                            <div className="relative h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-700">
                              <div className="h-full rounded-full bg-gradient-vicio" style={{ width: `${Math.max(1, r.pct * 100)}%` }} />
                              {r.pct_historico != null && (
                                <div className="absolute top-0 h-full w-0.5 bg-ink-800 dark:bg-white" style={{ left: `${Math.min(99, r.pct_historico * 100)}%` }} />
                              )}
                            </div>
                            <span className="flex items-center gap-2 tabular-nums text-ink-500 dark:text-ink-300">
                              <b className="text-ink-800 dark:text-white">{fmtPct(r.pct, 0)}</b>
                              {dif != null && Math.abs(dif) >= 2 && (
                                <span className={dif > 0 ? 'text-emerald-600' : 'text-accent-rose'}>{dif > 0 ? '+' : ''}{dif.toFixed(0)} pp</span>
                              )}
                              <span className="w-10 text-right" title="Chance média de compra de quem deu essa resposta">{fmtPct(r.prob_media, 0)}</span>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* melhores leads */}
          {painel.top_leads?.length > 0 && (
            <div className="card mt-4 px-5 py-4">
              <p className="text-sm font-semibold text-ink-800 dark:text-white">Melhores leads desta lista</p>
              <p className="text-xs text-ink-500 dark:text-ink-300">Os 15 com maior chance de compra. A lista completa está no CSV abaixo.
                {painel.resumo.teto_prob != null && (
                  <> A chance é limitada a {fmtPct(painel.resumo.teto_prob, 0)}: é o que de fato comprou entre os leads que o modelo pontuou acima de 40% em lançamentos que ele não viu.</>
                )}
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-ink-400">
                      <th className="py-1 font-medium">Lead</th>
                      <th className="py-1 font-medium">Telefone</th>
                      <th className="py-1 font-medium">Origem</th>
                      <th className="py-1 text-right font-medium">Nota</th>
                      <th className="py-1 text-right font-medium">Chance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {painel.top_leads.map((l, i) => (
                      <tr key={i} className="border-t border-ink-100 dark:border-ink-700/60">
                        <td className="max-w-[16rem] truncate py-1.5 text-ink-800 dark:text-white" title={l.email}>{l.nome || l.email}</td>
                        <td className="py-1.5 text-xs text-ink-500 dark:text-ink-300">{l.telefone || '—'}</td>
                        <td className="py-1.5 text-xs text-ink-500 dark:text-ink-300">{l.origem || '—'}</td>
                        <td className="py-1.5 text-right tabular-nums">{l.score}</td>
                        <td className="py-1.5 text-right font-semibold tabular-nums">{fmtPct(l.prob, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* por dia */}
          {painel.por_dia.length > 1 && (
            <div className="card mt-4 px-5 py-4">
              <p className="text-sm font-semibold text-ink-800 dark:text-white">Evolução por dia de cadastro</p>
              <p className="text-xs text-ink-500 dark:text-ink-300">Chance média de compra dos leads que entraram em cada dia.</p>
              <div className="mt-3 flex h-24 items-end gap-0.5 overflow-x-auto">
                {painel.por_dia.map((d) => (
                  <div key={d.dia || 'sem'} className="flex h-full min-w-[10px] flex-1 flex-col items-center justify-end"
                    title={`${fmtDia(d.dia)}: ${fmtNum(d.leads)} leads · chance ${fmtPct(d.prob_media)} · nota ${d.score_medio}`}>
                    <div className={`w-full rounded-t ${d.dia ? 'bg-gradient-vicio' : 'bg-ink-300'}`} style={{ height: `${Math.max(4, (d.prob_media / maxDia) * 100)}%` }} />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-ink-400">
                <span>{fmtDia(painel.por_dia[0].dia)}</span>
                <span>{fmtDia(painel.por_dia.filter((d) => d.dia).slice(-1)[0]?.dia)}</span>
              </div>
            </div>
          )}

          {/* baixar */}
          <div className="card mt-4 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <p className="text-sm text-ink-600 dark:text-ink-200">Baixe os leads com nota e probabilidade para acionar o comercial ou montar públicos.</p>
            <div className="flex flex-wrap gap-2">
              <a className="btn-primary" href={urlExportModelo(painel.modelo.id, 'hot', painel.base.id)} download>
                <Download size={15} /> Leads hot (CSV)
              </a>
              <a className="btn-ghost" href={urlExportModelo(painel.modelo.id, undefined, painel.base.id)} download>
                <Download size={15} /> Todos (CSV)
              </a>
            </div>
          </div>

          <p className="mt-4 text-[11px] leading-relaxed text-ink-400">
            A probabilidade é uma estimativa baseada no histórico de {painel.comparacao.bases_treino.map((b) => b.nome).join(' e ')}.
            Em um produto ou público diferente do treino, a ordem dos leads tende a valer, mas o nível absoluto pode
            ficar acima ou abaixo do real. Quando houver compradores desta base, cruze e treine de novo na tela Modelo.
          </p>
        </>
      )}
    </div>
  )
}
