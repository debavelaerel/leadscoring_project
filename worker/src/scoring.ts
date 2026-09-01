/**
 * Modelo de Lead Score — porte fiel de api/scoring.py.
 *
 * O Postgres devolve a tabela (pergunta, resposta, leads, compras). Aqui a
 * gente transforma isso em lift, peso e relevância:
 *
 *   1. taxa    = compras / leads da resposta
 *   2. lift    = taxa / taxa base da lista
 *   3. peso    = log do lift suavizado (Laplace) — acima da média soma,
 *                abaixo subtrai
 *   4. relevância da pergunta = V de Cramér (resposta × comprou)
 *
 * O score do lead (soma dos pesos → percentil 0–100) é calculado no banco,
 * porque depende de todas as linhas.
 */

export const SUAVIZACAO = 5 // leads "virtuais" por resposta — segura peso explosivo em amostra pequena
export const MIN_AMOSTRA = 30 // mínimo de leads pra resposta virar impulsionador
export const MAX_RESPOSTAS = 30 // acima disso a pergunta é texto aberto e sai do modelo
export const HOT = 80
export const WARM = 50
export const SEM_RESPOSTA = '(não respondeu)'

export interface Agregado {
  pergunta: string
  resposta: string
  leads: number
  compras: number
}

export interface RespostaStat {
  resposta: string
  leads: number
  compras: number
  taxa: number
  lift: number
  peso: number
}

export interface PerguntaStat {
  pergunta: string
  cramers_v: number
  respostas: RespostaStat[]
}

const arred = (x: number, casas: number): number => {
  const f = Math.pow(10, casas)
  return Math.round(x * f) / f
}

/** V de Cramér para a tabela resposta × comprou (2 colunas). */
export function cramersV(
  respostas: { leads: number; compras: number }[],
  total: number,
  totalCompras: number,
): number {
  if (total === 0 || totalCompras === 0 || totalCompras === total || respostas.length < 2) return 0
  const p = totalCompras / total
  let chi2 = 0
  for (const { leads: n, compras } of respostas) {
    if (n === 0) continue
    for (const [obs, prop] of [
      [compras, p],
      [n - compras, 1 - p],
    ] as [number, number][]) {
      const esperado = n * prop
      if (esperado > 0) chi2 += Math.pow(obs - esperado, 2) / esperado
    }
  }
  return Math.sqrt(chi2 / total) // min(dims) - 1 == 1
}

export interface Modelo {
  perguntas: PerguntaStat[]
  pesos: Record<string, Record<string, number>>
  impulsionadores: { positivos: (RespostaStat & { pergunta: string })[]; negativos: (RespostaStat & { pergunta: string })[] }
  taxa_base: number
  parametros: Record<string, number>
}

/** Agregado que sabe de qual base veio — insumo do modelo combinado. */
export interface AgregadoBase extends Agregado {
  dataset_id: string
}

export interface ResumoBase {
  dataset_id: string
  total_leads: number
  total_compras: number
}

const BASE_UNICA = '__unica__'

/**
 * @param agregados  saída de ls_agregados (já sem as perguntas abertas)
 * @param total      total de leads do dataset
 * @param compras    total de compradores identificados
 */
export function calcularModelo(agregados: Agregado[], total: number, compras: number): Modelo {
  return calcularModeloCombinado(
    agregados.map((a) => ({ ...a, dataset_id: BASE_UNICA })),
    [{ dataset_id: BASE_UNICA, total_leads: total, total_compras: compras }],
  )
}

/**
 * Modelo treinado sobre uma ou mais bases.
 *
 * O peso de cada resposta é a média — ponderada pelo nº de leads — do log-lift
 * calculado DENTRO de cada base, cada uma medida contra a própria taxa base.
 * Somar as contagens cruas de lançamentos diferentes misturaria "qual
 * lançamento" com "qual resposta": um lançamento que converteu mais faria toda
 * resposta dele parecer boa (paradoxo de Simpson). Com uma base só, isto
 * reduz exatamente à fórmula original.
 */
export function calcularModeloCombinado(agregados: AgregadoBase[], resumos: ResumoBase[]): Modelo {
  const totalGeral = resumos.reduce((s, r) => s + r.total_leads, 0)
  const comprasGeral = resumos.reduce((s, r) => s + r.total_compras, 0)
  const taxaBase = totalGeral ? comprasGeral / totalGeral : 0

  const taxaPorBase = new Map<string, number>()
  for (const r of resumos) {
    taxaPorBase.set(r.dataset_id, r.total_leads ? r.total_compras / r.total_leads : 0)
  }

  // pergunta -> resposta -> contagens de cada base
  const porPergunta = new Map<string, Map<string, AgregadoBase[]>>()
  for (const a of agregados) {
    let respostas = porPergunta.get(a.pergunta)
    if (!respostas) porPergunta.set(a.pergunta, (respostas = new Map()))
    const lista = respostas.get(a.resposta)
    if (lista) lista.push(a)
    else respostas.set(a.resposta, [a])
  }

  const perguntas: PerguntaStat[] = []
  const pesos: Record<string, Record<string, number>> = {}

  for (const [pergunta, respostas] of porPergunta) {
    pesos[pergunta] = {}

    const linhas = [...respostas.entries()].map(([resposta, porBase]) => {
      let n = 0
      let c = 0
      let somaPeso = 0
      let somaLift = 0

      for (const b of porBase) {
        const pBase = taxaPorBase.get(b.dataset_id) ?? taxaBase
        const taxaSuave = (b.compras + SUAVIZACAO * pBase) / (b.leads + SUAVIZACAO)
        const logLift = Math.log(Math.max(taxaSuave, 1e-9) / Math.max(pBase, 1e-9))
        const liftBase = pBase ? (b.leads ? b.compras / b.leads : 0) / pBase : 0
        somaPeso += b.leads * logLift
        somaLift += b.leads * liftBase
        n += b.leads
        c += b.compras
      }

      const peso = n ? somaPeso / n : 0
      pesos[pergunta][resposta] = peso
      return { resposta, leads: n, compras: c, taxa: n ? c / n : 0, lift: n ? somaLift / n : 0, peso }
    })

    // mais respondidas primeiro; nome como desempate pra ordem ser estável
    linhas.sort((a, b) => b.leads - a.leads || a.resposta.localeCompare(b.resposta, 'pt-BR'))

    const stats: RespostaStat[] = linhas.map((r) => ({
      resposta: r.resposta,
      leads: r.leads,
      compras: r.compras,
      taxa: arred(r.taxa, 4),
      lift: arred(r.lift, 2),
      peso: arred(r.peso, 4),
    }))

    perguntas.push({
      pergunta,
      cramers_v: arred(cramersV(linhas, totalGeral, comprasGeral), 4),
      respostas: stats,
    })
  }

  perguntas.sort((a, b) => b.cramers_v - a.cramers_v)

  const candidatos = perguntas.flatMap((p) =>
    p.respostas
      .filter((r) => r.leads >= MIN_AMOSTRA && r.resposta !== SEM_RESPOSTA)
      .map((r) => ({ ...r, pergunta: p.pergunta })),
  )

  return {
    perguntas,
    pesos,
    impulsionadores: {
      positivos: candidatos.filter((c) => c.lift > 1).sort((a, b) => b.lift - a.lift).slice(0, 8),
      negativos: candidatos.filter((c) => c.lift < 1).sort((a, b) => a.lift - b.lift).slice(0, 8),
    },
    taxa_base: arred(taxaBase, 4),
    parametros: { hot: HOT, warm: WARM, suavizacao: SUAVIZACAO, min_amostra: MIN_AMOSTRA },
  }
}
