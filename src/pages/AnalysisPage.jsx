import { Flame, Snowflake, ThermometerSun, TrendingUp, TrendingDown, UploadCloud, Users, Target, CheckCircle2 } from 'lucide-react'
import Dica from '../components/Dica.jsx'

/** Painel do Lead Score — impulsionadores, pesos por pergunta e calibração. */

const fmtPct = (v, casas = 1) => `${(v * 100).toFixed(casas)}%`
const fmtInt = (v) => (v ?? 0).toLocaleString('pt-BR')

function CardKpi({ icone: Icone, rotulo, valor, detalhe, destaque = false, dica }) {
  return (
    <div className={`${destaque ? 'card-dark' : 'card'} relative px-5 py-4`}>
      {dica && <Dica texto={dica} claro={destaque} />}
      <div className="flex items-center gap-2">
        <Icone size={15} className={destaque ? 'text-accent-lime' : 'text-vicio-500'} />
        <p className={`text-xs font-semibold uppercase tracking-wider ${destaque ? 'text-white/70' : 'text-ink-500 dark:text-ink-300'}`}>
          {rotulo}
        </p>
      </div>
      <p className={`mt-2 font-display text-2xl font-bold ${destaque ? 'text-white' : 'text-ink-900 dark:text-white'}`}>
        {valor}
      </p>
      {detalhe && (
        <p className={`mt-0.5 text-xs ${destaque ? 'text-white/60' : 'text-ink-500 dark:text-ink-300'}`}>{detalhe}</p>
      )}
    </div>
  )
}

function Barra({ pct, cor = 'bg-vicio-500' }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100 dark:bg-ink-700/60">
      <div className={`h-full rounded-full ${cor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  )
}

function ListaImpulsionadores({ titulo, itens, positivo }) {
  const Icone = positivo ? TrendingUp : TrendingDown
  return (
    <div className="card relative px-5 py-4">
      <Dica texto={`Respostas com pelo menos 30 leads, ordenadas pelo lift — taxa de conversão da resposta dividida pela taxa média da lista. ${positivo ? 'Lift acima de 1× indica resposta que aumenta a chance de compra.' : 'Lift abaixo de 1× indica resposta que reduz a chance de compra.'} Quem não respondeu a pesquisa fica fora deste ranking.`} />
      <div className="flex items-center gap-2">
        <Icone size={16} className={positivo ? 'text-accent-lime' : 'text-accent-rose'} />
        <p className="text-sm font-semibold text-ink-800 dark:text-white">{titulo}</p>
      </div>
      <ul className="mt-3 space-y-2.5">
        {itens.length === 0 && (
          <li className="text-xs text-ink-500 dark:text-ink-300">Nenhuma resposta com amostra suficiente.</li>
        )}
        {itens.map((r, i) => (
          <li key={i} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-ink-800 dark:text-ink-100" title={r.resposta}>{r.resposta}</p>
              <p className="truncate text-[11px] text-ink-400 dark:text-ink-400" title={r.pergunta}>{r.pergunta}</p>
            </div>
            <span className={`chip shrink-0 ${positivo ? 'bg-accent-lime/15 text-lime-700 dark:text-accent-lime' : 'bg-accent-rose/15 text-accent-rose'}`}>
              {r.lift.toFixed(2)}× · {fmtPct(r.taxa)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function AnalysisPage({ analise, irParaUpload }) {
  if (!analise) {
    return (
      <div className="grid min-h-[70vh] place-items-center px-4">
        <div className="card max-w-md px-8 py-10 text-center">
          <UploadCloud size={32} className="mx-auto text-vicio-400" />
          <p className="mt-4 font-display text-lg font-bold text-ink-900 dark:text-white">Nenhuma análise ainda</p>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
            Suba o CSV da pesquisa de leads para gerar o lead score.
          </p>
          <button className="btn-primary mx-auto mt-5" onClick={irParaUpload}>Nova análise</button>
        </div>
      </div>
    )
  }

  const { meta, stats } = analise
  const { classes, faixas_score, impulsionadores, perguntas } = stats
  const matchTotal = stats.total_compras

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="section-title">Lead Score</p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink-900 dark:text-white">{meta.nome}</h1>
          <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">
            {meta.arquivo} · {meta.criada_em?.replace('T', ' ')}
            {meta.mock && <span className="ml-2 chip bg-accent-amber/15 text-amber-600 dark:text-accent-amber">compradores mock</span>}
          </p>
        </div>
      </div>

      {/* KPIs */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <CardKpi icone={Users} rotulo="Leads na base" valor={fmtInt(stats.total_leads)}
          detalhe={`${fmtPct(stats.respondeu_pesquisa / stats.total_leads, 0)} responderam a pesquisa`}
          dica="Linhas do CSV da pesquisa após limpeza (e-mail minúsculo/validado; telefone só dígitos, sem o 55). O percentual indica quem respondeu ao menos uma pergunta fechada." />
        <CardKpi icone={CheckCircle2} rotulo="Compradores encontrados" valor={fmtInt(matchTotal)}
          detalhe={`${fmtInt(meta.match_email)} por e-mail · ${fmtInt(meta.match_telefone)} por telefone`}
          dica="Leads que constam como alunos ativos da turma no banco (role STUDENT + matrícula ativa na edição/produto). Match por e-mail exato; quem não bate por e-mail é procurado pelo telefone normalizado (com e sem o 9º dígito)." />
        <CardKpi icone={Target} rotulo="Conversão da lista" valor={fmtPct(stats.taxa_base)}
          detalhe={`${fmtInt(meta.compradores_banco)} alunos na turma (banco)`}
          dica="Compradores encontrados ÷ leads da base. É a taxa média usada como referência (lift 1×) para pesar cada resposta. O número menor é o total de alunos da turma no banco — nem todos passaram pela página de captura." />
        <CardKpi destaque icone={Flame} rotulo="Hot leads" valor={fmtInt(classes.hot.leads)}
          detalhe={`convertem a ${classes.hot.leads ? fmtPct(classes.hot.compras / classes.hot.leads) : '—'}`}
          dica="Leads com score 80 ou mais. O score 0–100 é o percentil do lead na lista: soma dos pesos das respostas dele (log do lift suavizado) comparada com todos os outros leads." />
      </div>

      {/* Classes */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {[
          { id: 'hot', rotulo: 'Hot', icone: Flame, cor: 'text-accent-rose', barra: 'bg-accent-rose' },
          { id: 'warm', rotulo: 'Warm', icone: ThermometerSun, cor: 'text-accent-amber', barra: 'bg-accent-amber' },
          { id: 'cold', rotulo: 'Cold', icone: Snowflake, cor: 'text-accent-cyan', barra: 'bg-accent-cyan' },
        ].map(({ id, rotulo, icone: Icone, cor, barra }) => {
          const c = classes[id]
          const pctLeads = stats.total_leads ? c.leads / stats.total_leads : 0
          const taxa = c.leads ? c.compras / c.leads : 0
          const dicaClasse = {
            hot: 'Score de 80 a 100 — o quinto do topo da lista. É a fatia para o comercial atacar primeiro.',
            warm: 'Score de 50 a 79 — acima da mediana, mas fora do topo. Bom alvo para nutrição e remarketing.',
            cold: 'Score abaixo de 50 — perfil com menor probabilidade de compra segundo o padrão histórico das respostas.',
          }[id]
          return (
            <div key={id} className="card relative px-5 py-4">
              <Dica texto={dicaClasse} />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icone size={16} className={cor} />
                  <p className="text-sm font-semibold text-ink-800 dark:text-white">{rotulo}</p>
                </div>
                <span className="mr-5 text-xs text-ink-500 dark:text-ink-300">{fmtPct(pctLeads, 0)} da lista</span>
              </div>
              <p className="mt-2 font-display text-xl font-bold text-ink-900 dark:text-white">{fmtInt(c.leads)} leads</p>
              <p className="text-xs text-ink-500 dark:text-ink-300">taxa de conversão {fmtPct(taxa)}</p>
              <div className="mt-2"><Barra pct={pctLeads * 100} cor={barra} /></div>
            </div>
          )
        })}
      </div>

      {/* Impulsionadores */}
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ListaImpulsionadores titulo="Maiores impulsionadores de compra" itens={impulsionadores.positivos} positivo />
        <ListaImpulsionadores titulo="Reduzem a chance de compra" itens={impulsionadores.negativos} positivo={false} />
      </div>

      {/* Calibração — conversão por faixa de score */}
      <div className="card relative mt-6 px-5 py-4">
        <Dica texto="Leads agrupados em faixas de 10 pontos de score; cada barra mostra a taxa de conversão real observada na faixa. Se o modelo está bom, a taxa cresce da esquerda para a direita. Passe o mouse na barra para ver leads e compras da faixa." />
        <p className="text-sm font-semibold text-ink-800 dark:text-white">Conversão real por faixa de score</p>
        <p className="text-xs text-ink-500 dark:text-ink-300">
          É a base da previsibilidade: em um novo lançamento, aplique estas taxas à distribuição de scores da lista.
        </p>
        <div className="mt-4 flex items-end gap-1.5" style={{ height: 120 }}>
          {faixas_score.map((f, i) => {
            const max = Math.max(...faixas_score.map((x) => x.taxa), 0.0001)
            return (
              <div key={i} className="group relative flex flex-1 flex-col items-center justify-end" style={{ height: '100%' }}>
                <div
                  className={`w-full rounded-t-md transition ${i >= 8 ? 'bg-accent-rose' : i >= 5 ? 'bg-accent-amber' : 'bg-vicio-400/70'}`}
                  style={{ height: `${Math.max((f.taxa / max) * 100, 2)}%` }}
                  title={`score ${f.faixa}: ${fmtPct(f.taxa)} (${fmtInt(f.compras)}/${fmtInt(f.leads)})`}
                />
                <span className="mt-1 text-[10px] text-ink-400">{f.faixa.split('–')[0]}</span>
              </div>
            )
          })}
        </div>
        <p className="mt-1 text-center text-[10px] uppercase tracking-wider text-ink-400">faixa de score (0–100)</p>
      </div>

      {/* Perguntas — pesos por resposta */}
      <div className="mt-6">
        <p className="section-title">Pesos por pergunta</p>
        {stats.perguntas_descartadas?.length > 0 && (
          <p className="mt-1 text-xs text-ink-400 dark:text-ink-400">
            Fora do modelo (pergunta aberta):{' '}
            {stats.perguntas_descartadas.map((d) => `"${d.pergunta}"`).join(' · ')}
          </p>
        )}
        <div className="mt-3 space-y-4">
          {perguntas.map((p) => (
            <div key={p.pergunta} className="card relative px-5 py-4">
              <Dica texto="Para cada resposta: nº de leads, taxa de conversão observada e lift (taxa ÷ média da lista). O peso no score é o log do lift com suavização — amostras pequenas puxam para o neutro. A relevância é o V de Cramér: força da associação entre a pergunta e a compra (0 = nenhuma, 1 = total). Perguntas abertas, com mais de 30 respostas distintas, ficam fora do modelo." />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-ink-800 dark:text-white">{p.pergunta}</p>
                <span className="chip mr-5 bg-vicio-100 text-vicio-800 dark:bg-vicio-900/60 dark:text-vicio-200"
                  title="Força da associação entre a resposta e a compra (V de Cramér)">
                  relevância {p.cramers_v.toFixed(3)}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {p.respostas.map((r) => {
                  const maxTaxa = Math.max(...p.respostas.map((x) => x.taxa), 0.0001)
                  const positiva = r.lift >= 1
                  return (
                    <div key={r.resposta} className="grid grid-cols-12 items-center gap-2 text-sm">
                      <span className="col-span-5 truncate text-ink-700 dark:text-ink-100" title={r.resposta}>
                        {r.resposta}
                      </span>
                      <div className="col-span-4"><Barra pct={(r.taxa / maxTaxa) * 100} cor={positiva ? 'bg-accent-lime/80' : 'bg-accent-rose/70'} /></div>
                      <span className="col-span-3 text-right text-xs tabular-nums text-ink-500 dark:text-ink-300">
                        {fmtPct(r.taxa)} · {r.lift.toFixed(2)}× · {fmtInt(r.leads)} leads
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
