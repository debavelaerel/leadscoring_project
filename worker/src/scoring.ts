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

// ---------------------------------------------------------------------------
// Regressão logística (L2) — substitui a soma de pesos como modelo de score.
//
// Por que: a soma de pesos trata as perguntas como independentes e conta duas
// vezes a mesma informação quando elas se sobrepõem. A logística aprende todos
// os pesos juntos e já devolve uma probabilidade de compra calibrada.
//
// Mesma forma de uso do modelo antigo: o score do lead continua sendo a soma
// dos pesos das respostas (aqui, coeficientes), então o SQL de percentil/classe
// não muda. A probabilidade é sigmoid(intercepto + soma).
// ---------------------------------------------------------------------------

export interface LinhaTreino {
  dataset_id: string
  respostas: Record<string, string | null>
  comprou: boolean
}

export interface Logistica {
  /** coeficientes por pergunta/resposta (mesmo formato de Modelo.pesos) */
  pesos: Record<string, Record<string, number>>
  /** intercepto de cada base + '*' (média ponderada, usada em lançamentos novos) */
  interceptos: Record<string, number>
  /** C escolhido por validação cruzada (maior C = menos regularização) */
  c: number
}

export const GRADE_C = [0.03, 0.1, 0.3, 1, 3, 10]
const DOBRAS = 5

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Resolve A x = b (A simétrica positiva) por eliminação gaussiana com pivô. */
function resolver(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((l, i) => [...l, b[i]])
  for (let i = 0; i < n; i++) {
    let p = i
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r
    ;[M[i], M[p]] = [M[p], M[i]]
    const d = M[i][i] || 1e-12
    for (let r = i + 1; r < n; r++) {
      const f = M[r][i] / d
      if (f) for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n]
    for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c]
    x[i] = s / (M[i][i] || 1e-12)
  }
  return x
}

interface Padrao {
  ativos: number[] // colunas ativas (1 da base + 1 por pergunta)
  n: number[] // leads por dobra
  k: number[] // compras por dobra
}

/** Newton-Raphson para minimizar logloss*soma + (1/(2C))·‖w penalizado‖². */
function ajustar(padroes: Padrao[], dobraFora: number, p: number, nPen0: number, C: number): number[] {
  const lambda = 1 / C
  const w = new Array<number>(p).fill(0)
  const nTreino = padroes.map((pd) => pd.n.reduce((s, v, f) => (f === dobraFora ? s : s + v), 0))
  const kTreino = padroes.map((pd) => pd.k.reduce((s, v, f) => (f === dobraFora ? s : s + v), 0))

  for (let it = 0; it < 30; it++) {
    const g = new Array<number>(p).fill(0)
    const H = Array.from({ length: p }, () => new Array<number>(p).fill(0))
    for (let i = 0; i < padroes.length; i++) {
      const n = nTreino[i]
      if (!n) continue
      const a = padroes[i].ativos
      let z = 0
      for (const j of a) z += w[j]
      const pr = 1 / (1 + Math.exp(-z))
      const gr = n * pr - kTreino[i]
      const h = n * pr * (1 - pr)
      for (const j of a) {
        g[j] += gr
        for (const l of a) H[j][l] += h
      }
    }
    for (let j = nPen0; j < p; j++) {
      g[j] += lambda * w[j]
      H[j][j] += lambda
    }
    for (let j = 0; j < nPen0; j++) H[j][j] += 1e-9
    const delta = resolver(H, g)
    let maior = 0
    for (let j = 0; j < p; j++) {
      w[j] -= delta[j]
      maior = Math.max(maior, Math.abs(delta[j]))
    }
    if (maior < 1e-7) break
  }
  return w
}

export function treinarLogistica(linhas: LinhaTreino[], perguntas: string[]): Logistica {
  const bases = [...new Set(linhas.map((l) => l.dataset_id))].sort()
  const idxBase = new Map(bases.map((b, i) => [b, i]))

  // colunas: 1 intercepto por base (sem penalização) + 1 por (pergunta, resposta)
  const nomes: { pergunta: string; resposta: string }[] = []
  const idxResp = new Map<string, number>()
  const resposta = (l: LinhaTreino, q: string) => (l.respostas[q] ?? '').toString().trim() || SEM_RESPOSTA
  for (const l of linhas) {
    for (const q of perguntas) {
      const chave = `${q}\u0000${resposta(l, q)}`
      if (!idxResp.has(chave)) {
        idxResp.set(chave, bases.length + nomes.length)
        nomes.push({ pergunta: q, resposta: resposta(l, q) })
      }
    }
  }
  const p = bases.length + nomes.length

  // agrupa leads idênticos (mesma base e mesmas respostas) → treino muito mais rápido
  const rng = mulberry32(20260507)
  const mapa = new Map<string, Padrao>()
  for (const l of linhas) {
    const ativos = [idxBase.get(l.dataset_id)!, ...perguntas.map((q) => idxResp.get(`${q}\u0000${resposta(l, q)}`)!)]
    const chave = ativos.join(',')
    let pd = mapa.get(chave)
    if (!pd) mapa.set(chave, (pd = { ativos, n: new Array(DOBRAS).fill(0), k: new Array(DOBRAS).fill(0) }))
    const f = Math.floor(rng() * DOBRAS)
    pd.n[f]++
    if (l.comprou) pd.k[f]++
  }
  const padroes = [...mapa.values()]

  // escolhe C: menor logloss fora da dobra, média das 5 dobras
  let melhorC = GRADE_C[0]
  let melhorPerda = Infinity
  for (const C of GRADE_C) {
    let perda = 0
    let total = 0
    for (let f = 0; f < DOBRAS; f++) {
      const w = ajustar(padroes, f, p, bases.length, C)
      for (const pd of padroes) {
        const n = pd.n[f]
        if (!n) continue
        let z = 0
        for (const j of pd.ativos) z += w[j]
        const pr = Math.min(Math.max(1 / (1 + Math.exp(-z)), 1e-9), 1 - 1e-9)
        perda -= pd.k[f] * Math.log(pr) + (n - pd.k[f]) * Math.log(1 - pr)
        total += n
      }
    }
    perda /= total || 1
    if (perda < melhorPerda) {
      melhorPerda = perda
      melhorC = C
    }
  }

  const w = ajustar(padroes, -1, p, bases.length, melhorC)
  const pesos: Record<string, Record<string, number>> = {}
  for (const q of perguntas) pesos[q] = {}
  nomes.forEach((nm, i) => {
    pesos[nm.pergunta][nm.resposta] = w[bases.length + i]
  })

  const porBase = new Map<string, number>()
  for (const l of linhas) porBase.set(l.dataset_id, (porBase.get(l.dataset_id) ?? 0) + 1)
  const interceptos: Record<string, number> = {}
  let soma = 0
  bases.forEach((b, i) => {
    interceptos[b] = w[i]
    soma += w[i] * (porBase.get(b) ?? 0)
  })
  interceptos['*'] = soma / (linhas.length || 1)

  return { pesos, interceptos, c: melhorC }
}
