/**
 * Lead Score Vício — API no Cloudflare Worker.
 *
 * Tudo mora no RDS, no schema `leadscore`: as bases, os leads normalizados, o
 * CSV original (comprimido) e as análises. O `plataforma1_espelho` continua
 * sendo lido, nunca escrito — os compradores saem dele ao vivo no cruzamento,
 * então nunca ficam defasados.
 *
 * O contrato das rotas é o mesmo do FastAPI original, então as telas de Análise
 * e Leads não mudaram.
 */

import { Buffer } from 'node:buffer'
import { Client } from 'pg'
import { Env, abrirConexao, comBanco, tuplas } from './db'
import { Mapeamento, PERGUNTA_ORIGEM, nomePadrao, prepararLead } from './etl'
import {
  Agregado, AgregadoBase, ResumoBase,
  LinhaTreino, calcularModelo, calcularModeloCombinado, treinarLogistica, MAX_RESPOSTAS, SEM_RESPOSTA,
} from './scoring'

interface Turma {
  oab: number
  curso: string
}

/** Aceita `turmas: [{oab,curso}]` ou o par `oab`/`curso` antigo. */
function turmasDoCorpo(corpo: { turmas?: Turma[]; oab?: number; curso?: string }): Turma[] {
  if (corpo.turmas?.length) {
    return corpo.turmas
      .filter((t) => t && Number(t.oab) && t.curso)
      .map((t) => ({ oab: Number(t.oab), curso: String(t.curso) }))
  }
  if (corpo.oab && corpo.curso) return [{ oab: Number(corpo.oab), curso: String(corpo.curso) }]
  return []
}

// ---------------------------------------------------------------- helpers ---

const json = (dados: unknown, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const erro = (status: number, detail: string) => json({ detail }, status)

class ErroHttp extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

interface Dataset {
  id: string
  nome: string
  arquivo_nome: string
  bytes: number | null
  oab: number | null
  curso: string | null
  colunas: string[]
  mapeamento: Mapeamento | null
  total_linhas: number
  status: string
  criado_em: string
}

async function pegarDataset(c: Client, id: string): Promise<Dataset> {
  const { rows } = await c.query('select * from leadscore.datasets where id = $1', [id])
  if (!rows.length) throw new ErroHttp(404, 'Base não encontrada.')
  return rows[0]
}

// ------------------------------------------------------------------ rotas ---

async function rotaTurmas(c: Client) {
  const { rows } = await c.query('select oab, curso, alunos::int from leadscore.ls_turmas()')
  return json({ turmas: rows, mock: false })
}

async function rotaCriarDataset(c: Client, req: Request) {
  const corpo = (await req.json()) as {
    nome?: string
    arquivo_nome?: string
    bytes?: number
    hash?: string
    oab?: number
    curso?: string
    colunas?: string[]
    mapeamento?: Mapeamento
  }
  if (!corpo.arquivo_nome) throw new ErroHttp(400, 'Informe o nome do arquivo.')
  if (!corpo.mapeamento?.email) throw new ErroHttp(400, 'Informe qual coluna contém o e-mail do lead.')
  if (!corpo.mapeamento?.perguntas?.length) throw new ErroHttp(400, 'Selecione ao menos uma pergunta da pesquisa.')

  if (corpo.hash) {
    const { rows } = await c.query(
      'select id, nome, criado_em from leadscore.datasets where hash = $1 limit 1',
      [corpo.hash],
    )
    if (rows.length) {
      return json(
        { duplicado: true, dataset: rows[0], detail: `Este arquivo já está no banco como "${rows[0].nome}".` },
        409,
      )
    }
  }

  const { rows } = await c.query(
    `insert into leadscore.datasets (nome, arquivo_nome, bytes, hash, oab, curso, colunas, mapeamento, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'enviando')
     returning *`,
    [
      corpo.nome || corpo.arquivo_nome,
      corpo.arquivo_nome,
      corpo.bytes ?? null,
      corpo.hash ?? null,
      corpo.oab ?? null,
      corpo.curso ?? null,
      JSON.stringify(corpo.colunas ?? []),
      JSON.stringify(corpo.mapeamento),
    ],
  )
  return json({ id: rows[0].id, dataset: rows[0] })
}

/** Guarda o CSV original (o navegador manda já comprimido em gzip). */
async function rotaGuardarArquivo(c: Client, req: Request, datasetId: string) {
  await pegarDataset(c, datasetId)
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (!bytes.length) throw new ErroHttp(400, 'Arquivo vazio.')
  const gzip = req.headers.get('x-conteudo-gzip') === '1'

  await c.query(
    `insert into leadscore.dataset_arquivos (dataset_id, conteudo, gzip, bytes)
     values ($1,$2,$3,$4)
     on conflict (dataset_id) do update
        set conteudo = excluded.conteudo, gzip = excluded.gzip,
            bytes = excluded.bytes, criado_em = now()`,
    [datasetId, Buffer.from(bytes), gzip, bytes.length],
  )
  return json({ ok: true, bytes: bytes.length, gzip })
}

async function rotaBaixarArquivo(c: Client, datasetId: string) {
  const dataset = await pegarDataset(c, datasetId)
  const { rows } = await c.query(
    'select conteudo, gzip from leadscore.dataset_arquivos where dataset_id = $1',
    [datasetId],
  )
  if (!rows.length) throw new ErroHttp(404, 'Esta base não tem o arquivo original guardado.')

  const bytes: Uint8Array = rows[0].conteudo
  // descomprime na saída (streaming, custo nativo) em vez de mexer em
  // content-encoding, que a borda pode reescrever
  const corpo = rows[0].gzip
    ? (new Response(bytes).body as ReadableStream).pipeThrough(new DecompressionStream('gzip'))
    : bytes

  return new Response(corpo, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${dataset.arquivo_nome}"`,
      'cache-control': 'no-store',
    },
  })
}

/** Recebe um lote de linhas cruas do CSV, normaliza e grava. */
async function rotaLinhas(c: Client, req: Request, datasetId: string) {
  const corpo = (await req.json()) as { inicio?: number; linhas?: Record<string, unknown>[] }
  const linhas = corpo.linhas || []
  if (!linhas.length) return json({ inseridas: 0 })

  const dataset = await pegarDataset(c, datasetId)
  if (!dataset.mapeamento) throw new ErroHttp(400, 'Base sem mapeamento de colunas.')

  const inicio = corpo.inicio ?? 0
  const prontas = linhas.map((linha, i) => prepararLead(linha, dataset.mapeamento!, datasetId, inicio + i))
  const { texto, valores } = tuplas(
    prontas.map((l) => [
      l.dataset_id, l.linha, l.nome, l.email, l.telefone_fmt,
      l.tel_chaves, l.data_lead, JSON.stringify(l.respostas), l.respondeu, JSON.stringify(l.extras),
    ]),
  )

  await c.query(
    `insert into leadscore.leads
       (dataset_id, linha, nome, email, telefone_fmt, tel_chaves, data_lead, respostas, respondeu, extras)
     values ${texto}
     on conflict (dataset_id, linha) do update
        set nome = excluded.nome, email = excluded.email,
            telefone_fmt = excluded.telefone_fmt, tel_chaves = excluded.tel_chaves,
            data_lead = excluded.data_lead, respostas = excluded.respostas,
            respondeu = excluded.respondeu, extras = excluded.extras`,
    valores,
  )
  return json({ inseridas: prontas.length })
}

async function rotaConcluirDataset(c: Client, req: Request, datasetId: string) {
  const corpo = (await req.json().catch(() => ({}))) as { total_linhas?: number; erro?: string }
  let total = corpo.total_linhas ?? 0

  if (!corpo.erro) {
    const dataset = await pegarDataset(c, datasetId)

    // 1) padroniza o nome das perguntas (listas de lançamentos diferentes usam redações diferentes)
    const renomear: Record<string, string> = {}
    const perguntas = (dataset.mapeamento?.perguntas || []).map((p: string) => {
      const n = nomePadrao(p)
      if (n !== p) renomear[p] = n
      return n
    })
    if (Object.keys(renomear).length) {
      await c.query(
        `update leadscore.leads l
            set respostas = (
              select coalesce(jsonb_object_agg(coalesce($2::jsonb ->> e.key, e.key), e.value), '{}'::jsonb)
                from jsonb_each(l.respostas) e)
          where dataset_id = $1`,
        [datasetId, JSON.stringify(renomear)],
      )
      await c.query(
        `update leadscore.datasets set mapeamento = jsonb_set(mapeamento, '{perguntas}', $2::jsonb) where id = $1`,
        [datasetId, JSON.stringify(perguntas)],
      )
    }

    // 2) a origem vira minúscula e sem espaços, pra "Meta-Ads" e "meta-ads" serem a mesma resposta
    if (perguntas.includes(PERGUNTA_ORIGEM)) {
      await c.query(
        `update leadscore.leads
            set respostas = jsonb_set(respostas, array[$2::text], to_jsonb(lower(trim(respostas ->> $2::text))))
          where dataset_id = $1 and nullif(trim(respostas ->> $2::text), '') is not null`,
        [datasetId, PERGUNTA_ORIGEM],
      )
    }

    // 3) só leads únicos: um por e-mail (sem e-mail, por telefone). Entre repetidos fica o
    //    cadastro com mais perguntas respondidas; empate, o primeiro da lista.
    await c.query(
      `delete from leadscore.leads l
        using (
          select id, row_number() over (
                   partition by dataset_id, coalesce(email, tel_chaves[1], id::text)
                   order by (select count(*) from jsonb_each_text(respostas) e
                              where nullif(trim(e.value), '') is not null
                                and e.key !~* 'utm_source|^origem do lead') desc,
                            linha) as rn
            from leadscore.leads where dataset_id = $1
        ) d
        where l.id = d.id and d.rn > 1`,
      [datasetId],
    )
    total = (await c.query('select count(*)::int as n from leadscore.leads where dataset_id = $1', [datasetId])).rows[0].n
  }

  const { rows } = await c.query(
    `update leadscore.datasets
        set status = $2, erro = $3, total_linhas = $4
      where id = $1
      returning *`,
    [datasetId, corpo.erro ? 'erro' : 'pronto', corpo.erro ?? null, total],
  )
  if (!rows.length) throw new ErroHttp(404, 'Base não encontrada.')
  return json({ dataset: rows[0] })
}

async function rotaListarDatasets(c: Client) {
  const { rows: datasets } = await c.query(`
    select d.id, d.nome, d.arquivo_nome, d.bytes, d.oab, d.curso, d.total_linhas,
           d.status, d.criado_em, d.mapeamento,
           (arq.dataset_id is not null) as tem_arquivo
      from leadscore.datasets d
      left join leadscore.dataset_arquivos arq on arq.dataset_id = d.id
     order by d.criado_em desc
     limit 200
  `)
  const { rows: analises } = await c.query(`
    select id, dataset_id, nome, criada_em
      from leadscore.analises
     order by criada_em desc
     limit 500
  `)
  const porDataset = new Map<string, unknown[]>()
  for (const a of analises) {
    const lista = porDataset.get(a.dataset_id) || []
    lista.push({ id: a.id, nome: a.nome, criada_em: a.criada_em })
    porDataset.set(a.dataset_id, lista)
  }
  return json({
    datasets: datasets.map((d) => ({
      ...d,
      perguntas: d.mapeamento?.perguntas?.length ?? 0,
      analises: porDataset.get(d.id) || [],
    })),
  })
}

async function rotaApagarDataset(c: Client, datasetId: string) {
  const { rowCount } = await c.query('delete from leadscore.datasets where id = $1', [datasetId])
  if (!rowCount) throw new ErroHttp(404, 'Base não encontrada.')
  return json({ ok: true })
}

/** O coração: cruza a base com a turma no espelho e monta o modelo. */
async function rotaCriarAnalise(c: Client, req: Request) {
  const corpo = (await req.json()) as {
    dataset_id?: string
    turmas?: Turma[]
    oab?: number
    curso?: string
    nome?: string
  }
  if (!corpo.dataset_id) throw new ErroHttp(400, 'Informe a base (dataset_id).')
  const turmas = turmasDoCorpo(corpo)
  if (!turmas.length) throw new ErroHttp(400, 'Selecione ao menos uma turma.')

  const dataset = await pegarDataset(c, corpo.dataset_id)
  const perguntas = dataset.mapeamento?.perguntas || []
  if (!perguntas.length) throw new ErroHttp(400, 'Base sem perguntas mapeadas.')

  // comprou = entrou em QUALQUER uma das turmas escolhidas
  const match = (
    await c.query('select leadscore.ls_match_turmas($1,$2) as r', [dataset.id, JSON.stringify(turmas)])
  ).rows[0].r as {
    match_email: number
    match_telefone: number
    compradores_banco: number
    por_turma: { turma: string; compras: number }[]
  }

  const { rows: distintas } = await c.query(
    'select pergunta, distintas from leadscore.ls_perguntas_distintas($1,$2)',
    [dataset.id, perguntas],
  )
  const descartadas = distintas
    .filter((d) => Number(d.distintas) > MAX_RESPOSTAS)
    .map((d) => ({ pergunta: d.pergunta, respostas_distintas: Number(d.distintas) }))
  const abertas = new Set(descartadas.map((d) => d.pergunta))
  const fechadas = perguntas.filter((p) => !abertas.has(p))

  const resumo = (await c.query('select leadscore.ls_resumo($1) as r', [dataset.id])).rows[0].r as {
    total_leads: number
    total_compras: number
    respondeu_pesquisa: number
  }
  if (!resumo || !resumo.total_leads) throw new ErroHttp(400, 'Base sem leads carregados.')
  // sem compradores todo peso vira zero e a análise apagaria o score da base (todos viram "cold")
  if (!resumo.total_compras) {
    throw new ErroHttp(
      400,
      'Nenhum lead desta base casou com compradores das turmas escolhidas, então não há o que aprender. ' +
        'Para pontuar uma base ainda sem vendas, use um modelo já treinado (CSV do modelo com ?dataset_id=).',
    )
  }

  const agregados: Agregado[] = fechadas.length
    ? (await c.query('select pergunta, resposta, leads, compras from leadscore.ls_agregados($1,$2)', [
        dataset.id,
        fechadas,
      ])).rows.map((a) => ({
        pergunta: a.pergunta,
        resposta: a.resposta,
        leads: Number(a.leads),
        compras: Number(a.compras),
      }))
    : []

  const modelo = calcularModelo(agregados, resumo.total_leads, resumo.total_compras)

  const aplicado = (
    await c.query('select leadscore.ls_aplicar_pesos($1,$2) as r', [dataset.id, JSON.stringify(modelo.pesos)])
  ).rows[0].r as { faixas_score: unknown[]; classes: Record<string, unknown> }
  // a soma de pesos não tem probabilidade: não deixa sobrar a de um modelo anterior
  await c.query('update leadscore.leads set prob = null where dataset_id = $1', [dataset.id])

  const stats = {
    total_leads: resumo.total_leads,
    total_compras: resumo.total_compras,
    taxa_base: modelo.taxa_base,
    respondeu_pesquisa: resumo.respondeu_pesquisa,
    perguntas: modelo.perguntas,
    perguntas_descartadas: descartadas,
    impulsionadores: modelo.impulsionadores,
    faixas_score: aplicado?.faixas_score || [],
    classes: aplicado?.classes || {},
    parametros: modelo.parametros,
  }

  const principal = turmas[0]
  const rotulo =
    turmas.length === 1
      ? `OAB ${principal.oab} — ${principal.curso}`
      : `OAB ${principal.oab} — ${turmas.length} turmas`
  const nome = corpo.nome || rotulo

  const metaBanco = {
    arquivo: dataset.arquivo_nome,
    compradores_banco: match.compradores_banco,
    match_email: match.match_email,
    match_telefone: match.match_telefone,
    turmas,
    por_turma: match.por_turma || [],
  }

  const { rows } = await c.query(
    `insert into leadscore.analises (dataset_id, nome, oab, curso, meta, stats, pesos)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id, criada_em`,
    [
      dataset.id, nome, principal.oab, turmas.map((t) => t.curso).join('+'),
      JSON.stringify(metaBanco), JSON.stringify(stats), JSON.stringify(modelo.pesos),
    ],
  )

  return json({
    id: rows[0].id,
    meta: {
      id: rows[0].id,
      dataset_id: dataset.id,
      nome,
      oab: principal.oab,
      curso: turmas.map((t) => t.curso).join('+'),
      criada_em: rows[0].criada_em,
      mock: false,
      ...metaBanco,
    },
    stats,
  })
}

// ---------------------------------------------------------------- modelos ---

/**
 * Treina um modelo sobre uma ou mais bases.
 *
 * Com 2+ bases o ganho é duplo: cada célula (pergunta × resposta) fica com mais
 * amostra, e dá pra medir a acurácia FORA da amostra — treinando sem uma base e
 * pontuando ela. Sem isso, todo número é in-sample e parece melhor do que é.
 */
async function rotaCriarModelo(c: Client, req: Request) {
  const corpo = (await req.json()) as {
    nome?: string
    datasets?: string[]
    perguntas?: string[]
    /** 'regressao_logistica' (padrão) ou 'soma_de_pesos' (modelo antigo, pra comparar) */
    metodo?: string
  }
  const metodo = corpo.metodo === 'soma_de_pesos' ? 'soma_de_pesos' : 'regressao_logistica'
  const datasets = [...new Set((corpo.datasets || []).filter(Boolean))]
  if (!datasets.length) throw new ErroHttp(400, 'Selecione ao menos uma base.')

  const { rows: bases } = await c.query(
    'select id, nome, oab, curso, total_linhas from leadscore.datasets where id = any($1)',
    [datasets],
  )
  if (bases.length !== datasets.length) throw new ErroHttp(404, 'Alguma das bases não existe mais.')
  const nomeDaBase = new Map(bases.map((b) => [b.id, b.nome]))

  // perguntas presentes em TODAS as bases (a menos que venham explícitas)
  const { rows: comuns } = await c.query('select pergunta, bases from leadscore.ls_perguntas_comuns($1)', [datasets])
  const emTodas = comuns.filter((r) => Number(r.bases) === datasets.length).map((r) => r.pergunta as string)
  const pedidas = corpo.perguntas?.length ? corpo.perguntas.filter((p) => emTodas.includes(p)) : emTodas
  if (!pedidas.length) {
    throw new ErroHttp(400, 'Essas bases não têm nenhuma pergunta em comum — o modelo combinado precisa das mesmas perguntas.')
  }

  const { rows: resumosRaw } = await c.query('select * from leadscore.ls_resumo_multi($1)', [datasets])
  const resumos: ResumoBase[] = resumosRaw.map((r) => ({
    dataset_id: r.dataset_id,
    total_leads: Number(r.total_leads),
    total_compras: Number(r.total_compras),
  }))
  const semCompras = resumos.filter((r) => r.total_compras === 0)
  if (semCompras.length) {
    throw new ErroHttp(400, `A base "${nomeDaBase.get(semCompras[0].dataset_id)}" não tem compradores marcados — rode a análise dela primeiro.`)
  }

  // pergunta aberta em qualquer base sai do modelo
  const descartadas: { pergunta: string; respostas_distintas: number }[] = []
  for (const d of datasets) {
    const { rows } = await c.query('select pergunta, distintas from leadscore.ls_perguntas_distintas($1,$2)', [d, pedidas])
    for (const r of rows) {
      if (Number(r.distintas) > MAX_RESPOSTAS && !descartadas.some((x) => x.pergunta === r.pergunta)) {
        descartadas.push({ pergunta: r.pergunta, respostas_distintas: Number(r.distintas) })
      }
    }
  }
  const fechadas = pedidas.filter((p) => !descartadas.some((d) => d.pergunta === p))
  if (!fechadas.length) throw new ErroHttp(400, 'Todas as perguntas em comum são de texto aberto.')

  const { rows: agRaw } = await c.query('select * from leadscore.ls_agregados_multi($1,$2)', [datasets, fechadas])
  const agregados: AgregadoBase[] = agRaw.map((a) => ({
    dataset_id: a.dataset_id,
    pergunta: a.pergunta,
    resposta: a.resposta,
    leads: Number(a.leads),
    compras: Number(a.compras),
  }))

  const modelo = calcularModeloCombinado(agregados, resumos)

  // pesos que realmente pontuam: coeficientes da logística (padrão) ou a soma de pesos antiga
  const { rows: linhasRaw } = await c.query(
    'select dataset_id, respostas, comprou from leadscore.leads where dataset_id = any($1)',
    [datasets],
  )
  const linhas: LinhaTreino[] = linhasRaw
  const treinar = (dsets: string[]) => {
    if (metodo === 'soma_de_pesos') {
      const m = calcularModeloCombinado(
        agregados.filter((a) => dsets.includes(a.dataset_id)),
        resumos.filter((r) => dsets.includes(r.dataset_id)),
      )
      return { pesos: m.pesos, interceptos: undefined as Record<string, number> | undefined, c: undefined as number | undefined }
    }
    return treinarLogistica(linhas.filter((l) => dsets.includes(l.dataset_id)), fechadas)
  }
  const final = treinar(datasets)
  if (metodo === 'regressao_logistica') {
    // a tela mostra o "peso" de cada resposta: aqui passa a ser o coeficiente da logística
    for (const pg of modelo.perguntas) {
      for (const r of pg.respostas) r.peso = Math.round((final.pesos[pg.pergunta]?.[r.resposta] ?? 0) * 10000) / 10000
    }
  }
  modelo.pesos = final.pesos

  let aplicado = await aplicarModelo(c, datasets, final.pesos, final.interceptos, null)
  let referencia: number[] | null = null
  let probMediaTreino: number | null = null
  if (final.interceptos) {
    // nota absoluta: o score passa a medir o lead contra a distribuição dos leads de treino
    ;({ referencia, media: probMediaTreino } = await referenciaDeProb(c, datasets))
    aplicado = await aplicarModelo(c, datasets, final.pesos, final.interceptos, referencia)
  }

  // --- validação -------------------------------------------------------------
  const validar = async (dataset: string, pesos: unknown) =>
    (await c.query('select leadscore.ls_validar($1,$2) as r', [dataset, JSON.stringify(pesos)])).rows[0].r

  const validacao: unknown[] = []
  // previsões de cada base feitas por um modelo que NÃO a viu: é assim que a chance se comporta num lançamento novo
  const foraDaBase: { p: number; y: boolean }[] = []
  for (const d of datasets) {
    const dentro = await validar(d, final.pesos)
    let fora = null
    if (datasets.length >= 2) {
      // treina sem esta base (inclusive a escolha do C) e pontua ela — acurácia honesta
      const treino = treinar(datasets.filter((x) => x !== d))
      fora = await validar(d, treino.pesos)
      if (treino.interceptos) {
        const b0 = treino.interceptos['*']
        for (const l of linhas) {
          if (l.dataset_id !== d) continue
          let z = b0
          for (const q of fechadas) z += treino.pesos[q]?.[(l.respostas[q] ?? '').toString().trim() || SEM_RESPOSTA] ?? 0
          foraDaBase.push({ p: 1 / (1 + Math.exp(-z)), y: l.comprou })
        }
      }
    }
    validacao.push({ dataset_id: d, base: nomeDaBase.get(d), dentro_da_amostra: dentro, fora_da_amostra: fora })
  }

  // Teto da chance exibida. Acima de ~40% a previsão sai otimista em lançamento novo (previu 45%, comprou 38%),
  // e um calibrador ajustado em um lançamento não se sustenta no outro. Então a chance mostrada nunca passa da
  // taxa que de fato comprou entre os leads que o modelo pontuou acima do corte. Não muda a ordem dos leads.
  const CORTE_TETO = 0.4
  const acimaDoCorte = foraDaBase.filter((x) => x.p >= CORTE_TETO)
  const taxaAcima = acimaDoCorte.length ? acimaDoCorte.filter((x) => x.y).length / acimaDoCorte.length : null
  const tetoProb =
    acimaDoCorte.length >= 30 && taxaAcima !== null && taxaAcima < CORTE_TETO
      ? Math.round(taxaAcima * 100) / 100
      : null

  const stats = {
    total_leads: resumos.reduce((s, r) => s + r.total_leads, 0),
    total_compras: resumos.reduce((s, r) => s + r.total_compras, 0),
    taxa_base: modelo.taxa_base,
    respondeu_pesquisa: resumosRaw.reduce((s, r) => s + Number(r.respondeu), 0),
    perguntas: modelo.perguntas,
    perguntas_descartadas: descartadas,
    impulsionadores: modelo.impulsionadores,
    faixas_score: aplicado?.faixas_score || [],
    classes: aplicado?.classes || {},
    parametros: {
      ...modelo.parametros,
      metodo,
      ...(final.c !== undefined ? { c_regularizacao: final.c } : {}),
    },
    interceptos: final.interceptos ?? null,
    referencia,
    prob_media_treino: probMediaTreino,
    teto_prob: tetoProb,
    teto_corte: CORTE_TETO,
    teto_amostra: acimaDoCorte.length,
    bases: resumos.map((r) => ({
      dataset_id: r.dataset_id,
      nome: nomeDaBase.get(r.dataset_id),
      leads: r.total_leads,
      compras: r.total_compras,
      taxa_base: r.total_leads ? Math.round((r.total_compras / r.total_leads) * 10000) / 10000 : 0,
    })),
  }

  const nome = corpo.nome || `Modelo · ${bases.map((b) => b.nome).join(' + ')}`
  const { rows } = await c.query(
    `insert into leadscore.modelos (nome, datasets, perguntas, pesos, stats, validacao)
     values ($1,$2,$3,$4,$5,$6)
     returning id, criado_em`,
    [nome, datasets, fechadas, JSON.stringify(modelo.pesos), JSON.stringify(stats), JSON.stringify(validacao)],
  )

  return json({ id: rows[0].id, nome, criado_em: rows[0].criado_em, stats, validacao })
}

async function rotaListarModelos(c: Client) {
  const { rows } = await c.query(`
    select m.id, m.nome, m.datasets, m.perguntas, m.criado_em,
           m.stats -> 'total_leads'   as total_leads,
           m.stats -> 'total_compras' as total_compras,
           m.stats -> 'taxa_base'     as taxa_base,
           m.validacao
      from leadscore.modelos m
     order by m.criado_em desc
     limit 100
  `)
  return json({ modelos: rows })
}

async function rotaModelo(c: Client, id: string) {
  const { rows } = await c.query('select * from leadscore.modelos where id = $1', [id])
  if (!rows.length) throw new ErroHttp(404, 'Modelo não encontrado.')
  return json({ modelo: rows[0] })
}

/** utm_source → grupo. O nome da origem muda de um lançamento para outro; o grupo é o que o modelo usa. */
const GRUPOS_ORIGEM: Record<string, string> = {
  'meta-ads': 'pago', 'google-ads': 'pago', pago: 'pago',
  instagram: 'organico', site: 'organico', organico: 'organico', org: 'organico',
  whatsapp: 'base propria', email: 'base propria',
}

/**
 * O modelo completo em JSON — é este arquivo que alimenta o Optimiz.
 * Traz tudo o que é preciso para reproduzir o score igual ao desta tela, sem depender do nosso banco:
 * pesos, intercepto, tabela de nota, teto, cortes e a regra de agrupamento da origem.
 */
async function rotaPesosDoModelo(c: Client, id: string) {
  const { rows } = await c.query('select id, nome, perguntas, pesos, criado_em, stats, validacao from leadscore.modelos where id = $1', [id])
  if (!rows.length) throw new ErroHttp(404, 'Modelo não encontrado.')
  const m = rows[0]
  const logistica = Boolean(m.stats?.interceptos && m.stats?.referencia)
  const perguntaOrigem = ((m.perguntas || []) as string[]).find((p) => /utm_source/i.test(p)) ?? 'Origem do lead (utm_source)'
  const perguntaGrupo = ((m.perguntas || []) as string[]).find((p) => /\(grupo\)/i.test(p)) ?? null
  const aucs = ((m.validacao || []) as any[]).map((v) => v?.fora_da_amostra?.auc).filter((a) => typeof a === 'number')
  const corpo = JSON.stringify(
    {
      formato: 'leadscore-modelo/2',
      modelo: m.nome,
      id: m.id,
      gerado_em: m.criado_em,
      parametros: { hot: 80, warm: 50 },
      perguntas: m.perguntas,
      pesos: m.pesos,
      // --- o que falta para reproduzir o score (só modelos de regressão logística) ---
      ...(logistica
        ? {
            resposta_em_branco: SEM_RESPOSTA,
            resposta_desconhecida: { peso: 0 },
            intercepto: m.stats.interceptos['*'],
            probabilidade: '1 / (1 + exp(-(intercepto + soma dos pesos das respostas do lead)))',
            teto_probabilidade: Number(m.stats.teto_prob) > 0 ? Number(m.stats.teto_prob) : 1,
            nota: {
              regra: 'nota = min(100, max(0, quantos valores de `quantis` são <= probabilidade, menos 1)). Usa a probabilidade SEM o teto.',
              quantis: (m.stats.referencia as unknown[]).map(Number),
            },
            classes: 'hot se nota >= parametros.hot; warm se nota >= parametros.warm; senão cold',
            ...(perguntaGrupo
              ? {
                  origem: {
                    pergunta_origem: perguntaOrigem,
                    pergunta_grupo: perguntaGrupo,
                    regra: 'minúsculas e sem espaços nas pontas; vazio = em branco; fora do mapa = "outro"',
                    mapa: GRUPOS_ORIGEM,
                    padrao: 'outro',
                  },
                }
              : {}),
            validacao_fora_da_amostra: aucs.length
              ? { auc_medio: Math.round((aucs.reduce((s, a) => s + a, 0) / aucs.length) * 1000) / 1000, bases: aucs.length }
              : null,
          }
        : { aviso: 'Modelo da versão antiga (soma de pesos, sem probabilidade). Treine de novo para exportar o modelo completo.' }),
    },
    null,
    2,
  )
  return new Response(corpo, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="pesos_${id.slice(0, 8)}.json"`,
    },
  })
}

const metaDe = (a: any) => ({
  id: a.id,
  dataset_id: a.dataset_id,
  nome: a.nome,
  oab: a.oab,
  curso: a.curso,
  criada_em: a.criada_em,
  mock: false,
  ...(a.meta || {}),
})

async function rotaListarAnalises(c: Client) {
  const { rows } = await c.query(`
    select id, dataset_id, nome, oab, curso, meta, criada_em
      from leadscore.analises
     order by criada_em desc
     limit 100
  `)
  return json({ analises: rows.map(metaDe) })
}

async function pegarAnalise(c: Client, id: string) {
  const { rows } = await c.query('select * from leadscore.analises where id = $1', [id])
  if (!rows.length) throw new ErroHttp(404, 'Análise não encontrada.')
  return rows[0]
}

async function rotaAnalise(c: Client, id: string) {
  const a = await pegarAnalise(c, id)
  return json({ meta: metaDe(a), stats: a.stats })
}

/** Monta o WHERE da lista de leads a partir dos filtros da tela. */
function filtrosLeads(datasetId: string, url: URL) {
  const cond: string[] = ['dataset_id = $1']
  const valores: unknown[] = [datasetId]

  const classe = url.searchParams.get('classe')
  if (classe && ['hot', 'warm', 'cold'].includes(classe)) {
    valores.push(classe)
    cond.push(`classe = $${valores.length}`)
  }
  if (url.searchParams.get('sem_compradores') === 'true') cond.push('comprou = false')

  const busca = (url.searchParams.get('busca') || '').trim()
  if (busca) {
    valores.push(`%${busca}%`)
    cond.push(`(email ilike $${valores.length} or nome ilike $${valores.length})`)
  }
  return { where: cond.join(' and '), valores }
}

const leadPublico = (l: any) => ({
  idx: l.linha,
  nome: l.nome,
  email: l.email,
  telefone_fmt: l.telefone_fmt,
  data: l.data_lead,
  respostas: l.respostas,
  respondeu: l.respondeu,
  comprou: l.comprou,
  comprou_em: l.comprou_em || [],
  match_via: l.match_via,
  score: l.score,
  prob: l.prob === null || l.prob === undefined ? null : Math.round(Number(l.prob) * 10000) / 10000,
  classe: l.classe,
})

async function rotaLeads(c: Client, id: string, url: URL) {
  const a = await pegarAnalise(c, id)
  const pagina = Math.max(Number(url.searchParams.get('pagina') || 1), 1)
  const porPagina = Math.min(Math.max(Number(url.searchParams.get('por_pagina') || 50), 1), 500)
  const { where, valores } = filtrosLeads(a.dataset_id, url)

  const total = Number(
    (await c.query(`select count(*)::int as n from leadscore.leads where ${where}`, valores)).rows[0].n,
  )
  const { rows } = await c.query(
    `select linha, nome, email, telefone_fmt, data_lead, respostas, respondeu, comprou, comprou_em, match_via, score, prob, classe
       from leadscore.leads
      where ${where}
      order by score desc nulls last, linha asc
      limit $${valores.length + 1} offset $${valores.length + 2}`,
    [...valores, porPagina, (pagina - 1) * porPagina],
  )
  return json({ total, pagina, por_pagina: porPagina, leads: rows.map(leadPublico) })
}

const campoCsv = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v)
  // texto vindo do lead (nome, e-mail, respostas) não pode virar fórmula no Excel/Sheets;
  // números ficam como estão (um score negativo não é fórmula)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Export pro comercial — paginado, pra não segurar a base inteira na memória. */
async function rotaExport(env: Env, id: string, url: URL) {
  const c = await abrirConexao(env)
  let a: any
  try {
    a = await pegarAnalise(c, id)
  } catch (e) {
    await c.end().catch(() => {})
    throw e
  }

  const perguntas = ((a.stats?.perguntas || []) as any[]).map((p) => p.pergunta) as string[]
  const { where, valores } = filtrosLeads(a.dataset_id, url)
  const classe = url.searchParams.get('classe')
  const nome = `leadscore_${a.oab}${classe ? `_${classe}` : ''}.csv`
  const LOTE = 2000

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode('﻿'))
      controller.enqueue(
        enc.encode(
          ['nome', 'email', 'telefone', 'score', 'classe', 'comprou', ...perguntas].map(campoCsv).join(',') + '\n',
        ),
      )
      let offset = 0
      try {
        for (;;) {
          const { rows } = await c.query(
            `select nome, email, telefone_fmt, comprou, score, classe, respostas
               from leadscore.leads
              where ${where}
              order by score desc nulls last, linha asc
              limit $${valores.length + 1} offset $${valores.length + 2}`,
            [...valores, LOTE, offset],
          )
          for (const l of rows) {
            controller.enqueue(
              enc.encode(
                [
                  l.nome,
                  l.email || '',
                  l.telefone_fmt,
                  l.score,
                  l.classe,
                  l.comprou ? 'sim' : 'nao',
                  ...perguntas.map((p) => l.respostas?.[p] || ''),
                ]
                  .map(campoCsv)
                  .join(',') + '\n',
              ),
            )
          }
          if (rows.length < LOTE) break
          offset += LOTE
        }
      } catch (e) {
        controller.enqueue(enc.encode(`\n# erro ao exportar: ${(e as Error).message}\n`))
      } finally {
        await c.end().catch(() => {})
        controller.close()
      }
    },
    async cancel() {
      await c.end().catch(() => {})
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${nome}"`,
      'cache-control': 'no-store',
    },
  })
}

/**
 * Export dos leads de um modelo (todas as bases dele) com a probabilidade de compra.
 * Reaplica o modelo antes, pra score/classe/probabilidade serem exatamente os dele
 * (a tabela de leads guarda só o último modelo ou análise aplicado).
 */
async function rotaExportModelo(env: Env, id: string, url: URL) {
  const c = await abrirConexao(env)
  let m: any
  try {
    const { rows } = await c.query('select * from leadscore.modelos where id = $1', [id])
    if (!rows.length) throw new ErroHttp(404, 'Modelo não encontrado.')
    m = rows[0]
    // ?dataset_id=… pontua OUTRA base (ex.: lançamento novo, ainda sem compradores) com este modelo
    const outra = url.searchParams.get('dataset_id')
    if (outra) {
      await pegarDataset(c, outra)
      m = { ...m, datasets: [outra] }
    }
    const interceptos = m.stats?.interceptos
    await aplicarModelo(c, m.datasets, m.pesos, interceptos ?? null, m.stats?.referencia ?? null)
  } catch (e) {
    await c.end().catch(() => {})
    throw e
  }

  const tetoExport = Number(m.stats?.teto_prob) > 0 ? Number(m.stats.teto_prob) : 1
  const classe = url.searchParams.get('classe')
  const filtroClasse = classe && ['hot', 'warm', 'cold'].includes(classe) ? classe : null
  const perguntas = (m.perguntas || []) as string[]
  const LOTE = 2000

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode('\ufeff'))
      controller.enqueue(
        enc.encode(
          ['base', 'nome', 'email', 'telefone', 'score', 'probabilidade', 'classe', 'comprou', ...perguntas]
            .map(campoCsv)
            .join(',') + '\n',
        ),
      )
      let offset = 0
      try {
        for (;;) {
          const { rows } = await c.query(
            `select d.nome as base, l.nome, l.email, l.telefone_fmt, l.comprou, l.score, l.prob, l.classe, l.respostas
               from leadscore.leads l
               join leadscore.datasets d on d.id = l.dataset_id
              where l.dataset_id = any($1) and ($2::text is null or l.classe = $2)
              order by l.prob desc nulls last, l.score desc nulls last, l.dataset_id, l.linha
              limit $3 offset $4`,
            [m.datasets, filtroClasse, LOTE, offset],
          )
          for (const l of rows) {
            controller.enqueue(
              enc.encode(
                [
                  l.base,
                  l.nome,
                  l.email || '',
                  l.telefone_fmt,
                  l.score,
                  l.prob === null ? '' : Math.min(Number(l.prob), tetoExport).toFixed(4),
                  l.classe,
                  l.comprou ? 'sim' : 'nao',
                  ...perguntas.map((p) => l.respostas?.[p] || ''),
                ]
                  .map(campoCsv)
                  .join(',') + '\n',
              ),
            )
          }
          if (rows.length < LOTE) break
          offset += LOTE
        }
      } catch (e) {
        controller.enqueue(enc.encode(`\n# erro ao exportar: ${(e as Error).message}\n`))
      } finally {
        await c.end().catch(() => {})
        controller.close()
      }
    },
    async cancel() {
      await c.end().catch(() => {})
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="leadscore_modelo${filtroClasse ? `_${filtroClasse}` : ''}.csv"`,
      'cache-control': 'no-store',
    },
  })
}

type Aplicado = { faixas_score: any[]; classes: Record<string, any> }

/** Grava score/prob/classe dos leads das bases com os pesos de um modelo. */
async function aplicarModelo(
  c: Client,
  datasets: string[],
  pesos: unknown,
  interceptos: Record<string, number> | null | undefined,
  referencia: number[] | null | undefined,
): Promise<Aplicado> {
  const { rows } = await c.query('select leadscore.ls_aplicar_pesos_multi($1,$2,$3,$4) as r', [
    datasets,
    JSON.stringify(pesos),
    interceptos ? JSON.stringify(interceptos) : null,
    referencia ? JSON.stringify(referencia) : null,
  ])
  return rows[0].r as Aplicado
}

/** 101 quantis (0..100) e a média da probabilidade dos leads já pontuados. */
async function referenciaDeProb(c: Client, datasets: string[]): Promise<{ referencia: number[]; media: number }> {
  const { rows } = await c.query(
    `select percentile_cont(array(select g / 100.0 from generate_series(0, 100) g)) within group (order by prob) as q,
            avg(prob)::float8 as media
       from leadscore.leads where dataset_id = any($1) and prob is not null`,
    [datasets],
  )
  return { referencia: (rows[0].q as number[]).map(Number), media: Number(rows[0].media) }
}

const arr4 = (x: unknown): number => Math.round(Number(x) * 10000) / 10000

// t de Student bilateral 95% por graus de liberdade (1..10); acima disso, ≈ normal
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228]

/**
 * Intervalo de previsão (95%) da taxa de conversão de um lançamento novo, a partir das taxas dos lançamentos de
 * treino (meta-análise de efeitos aleatórios no logit, DerSimonian-Laird). Precisa de 3+ bases; senão devolve null.
 */
function intervaloNovoLancamento(bases: { n: number; x: number }[]): [number | null, number | null] {
  const b = bases.filter((v) => v.n > 0 && v.x > 0 && v.x < v.n)
  const k = b.length
  if (k < 3) return [null, null]
  const y = b.map((v) => Math.log(v.x / (v.n - v.x)))
  const vr = b.map((v) => 1 / v.x + 1 / (v.n - v.x)) // variância do logit de uma proporção
  const w = vr.map((s) => 1 / s)
  const sw = w.reduce((s, v) => s + v, 0)
  const muF = w.reduce((s, v, i) => s + v * y[i], 0) / sw
  const Q = w.reduce((s, v, i) => s + v * (y[i] - muF) ** 2, 0)
  const tau2 = Math.max(0, (Q - (k - 1)) / (sw - w.reduce((s, v) => s + v * v, 0) / sw))
  const ws = vr.map((s) => 1 / (s + tau2))
  const sws = ws.reduce((s, v) => s + v, 0)
  const mu = ws.reduce((s, v, i) => s + v * y[i], 0) / sws
  const t = T95[Math.min(Math.max(k - 2, 1), T95.length) - 1]
  const meia = t * Math.sqrt(tau2 + 1 / sws)
  const expit = (z: number) => 1 / (1 + Math.exp(-z))
  return [expit(mu - meia), expit(mu + meia)]
}

/**
 * Painel da captação: pontua uma base (com ou sem compradores) com um modelo e
 * resume a qualidade dela contra o histórico de treino do modelo.
 */
async function rotaCaptacao(c: Client, req: Request) {
  const corpo = (await req.json()) as { modelo_id?: string; dataset_id?: string; taxa_alvo?: number }
  if (!corpo.modelo_id || !corpo.dataset_id) throw new ErroHttp(400, 'Informe o modelo e a base.')
  const taxaAlvo = Number(corpo.taxa_alvo)
  if (corpo.taxa_alvo != null && !(taxaAlvo > 0 && taxaAlvo < 1)) {
    throw new ErroHttp(400, 'A taxa observada precisa estar entre 0 e 100%.')
  }
  const { rows: ms } = await c.query('select * from leadscore.modelos where id = $1', [corpo.modelo_id])
  if (!ms.length) throw new ErroHttp(404, 'Modelo não encontrado.')
  const modelo = ms[0]
  if (!modelo.stats?.interceptos || !modelo.stats?.referencia) {
    throw new ErroHttp(400, 'Este modelo é de uma versão antiga (sem probabilidade). Treine o modelo de novo na tela Modelo.')
  }
  const dataset = await pegarDataset(c, corpo.dataset_id)
  const d = [dataset.id]

  await aplicarModelo(c, d, modelo.pesos, modelo.stats.interceptos, modelo.stats.referencia)
  const teto = Number(modelo.stats.teto_prob) > 0 ? Number(modelo.stats.teto_prob) : 1

  // Recalibração do nível: o modelo acerta a ORDEM dos leads, mas o nível da conversão muda de lançamento
  // para lançamento (7,9% a 11,1% nas bases de treino) e as respostas da pesquisa não explicam isso. Com a taxa
  // observada da captação, desloca o intercepto (em logit) até a média bater com ela. Não mexe em score nem classe.
  let delta = 0
  let probMediaAntes: number | null = null
  if (taxaAlvo > 0) {
    const { rows: ps } = await c.query('select prob::float8 as p from leadscore.leads where dataset_id = $1 and prob is not null', d)
    const logits = ps.map((r: { p: number }) => {
      const p = Math.min(Math.max(r.p, 1e-6), 1 - 1e-6)
      return Math.log(p / (1 - p))
    })
    const media = (dl: number) =>
      logits.reduce((s: number, z: number) => s + Math.min(1 / (1 + Math.exp(-(z + dl))), teto), 0) / (logits.length || 1)
    probMediaAntes = media(0)
    let lo = -6
    let hi = 6
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2
      if (media(mid) < taxaAlvo) lo = mid
      else hi = mid
    }
    delta = (lo + hi) / 2
  }
  const probSql = (col: string) => {
    const t = teto.toFixed(4)
    if (delta === 0) return `least(${col}, ${t})`
    const p = `least(greatest(${col}, 1e-6), 1 - 1e-6)`
    return `least(1 / (1 + exp(-(ln(${p} / (1 - ${p})) + ${delta.toFixed(6)}))), ${t})`
  }
  const P = probSql('prob') // chance exibida: nunca acima do teto observado em lançamento novo
  const PL = probSql('l.prob')

  const R = (
    await c.query(
      `select count(*)::int as leads,
              count(*) filter (where respondeu)::int as responderam,
              avg(${P})::float8 as prob_media, sum(${P})::float8 as compras_esperadas,
              avg(score)::float8 as score_medio,
              count(*) filter (where classe = 'hot')::int as hot,
              count(*) filter (where classe = 'warm')::int as warm,
              count(*) filter (where classe = 'cold')::int as cold,
              count(*) filter (where comprou)::int as compradores
         from leadscore.leads where dataset_id = $1`,
      d,
    )
  ).rows[0]

  const faixas = (
    await c.query(
      `select least(score / 10, 9) as ord, count(*)::int as leads, avg(${P})::float8 as prob_media
         from leadscore.leads where dataset_id = $1 group by 1 order by 1`,
      d,
    )
  ).rows.map((f: any) => ({
    faixa: `${f.ord * 10}–${f.ord === 9 ? 100 : f.ord * 10 + 9}`,
    leads: f.leads,
    prob_media: arr4(f.prob_media),
  }))

  const perguntaOrigem = ((modelo.perguntas || []) as string[]).find((p) => /origem|utm_source/i.test(p))
  const historicoPorOrigem = new Map<string, number>()
  if (perguntaOrigem) {
    const { rows } = await c.query(
      `select coalesce(nullif(respostas ->> $2, ''), '(sem origem)') as origem,
              (count(*) filter (where comprou))::float8 / count(*) as taxa
         from leadscore.leads where dataset_id = any($1) group by 1 having count(*) >= 30`,
      [modelo.datasets, perguntaOrigem],
    )
    for (const r of rows) historicoPorOrigem.set(r.origem, Number(r.taxa))
  }
  const porOrigem = perguntaOrigem
    ? (
        await c.query(
          `select coalesce(nullif(respostas ->> $2, ''), '(sem origem)') as origem,
                  count(*)::int as leads, avg(${P})::float8 as prob_media, avg(score)::float8 as score_medio,
                  (count(*) filter (where classe = 'hot'))::float8 / count(*) as pct_hot
             from leadscore.leads where dataset_id = $1
            group by 1 order by 2 desc limit 12`,
          [dataset.id, perguntaOrigem],
        )
      ).rows.map((o: any) => ({
        origem: o.origem,
        leads: o.leads,
        prob_media: arr4(o.prob_media),
        score_medio: Math.round(o.score_medio),
        pct_hot: arr4(o.pct_hot),
        taxa_historica: historicoPorOrigem.has(o.origem) ? arr4(historicoPorOrigem.get(o.origem)) : null,
      }))
    : []

  const porDia = (
    await c.query(
      `select substring(data_lead from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') as dia, count(*)::int as leads,
              avg(${P})::float8 as prob_media, avg(score)::float8 as score_medio
         from leadscore.leads where dataset_id = $1
        group by 1 order by 1 nulls last`,
      d,
    )
  ).rows.map((x: any) => ({ dia: x.dia, leads: x.leads, prob_media: arr4(x.prob_media), score_medio: Math.round(x.score_medio) }))

  // --- perfil do público: distribuição de cada resposta aqui vs. nas bases de treino ---
  const respostasPerfil = ((modelo.perguntas || []) as string[]).filter((p) => p !== perguntaOrigem)
  const perfil: unknown[] = []
  if (respostasPerfil.length) {
    const agg = async (datasets: string[]) =>
      (
        await c.query(
          `select e.key as pergunta, coalesce(nullif(trim(e.value), ''), '(não respondeu)') as resposta,
                  count(*)::int as leads, avg(${PL})::float8 as prob_media
             from leadscore.leads l
             cross join lateral jsonb_each_text(l.respostas) e
            where l.dataset_id = any($1) and e.key = any($2)
            group by 1, 2`,
          [datasets, respostasPerfil],
        )
      ).rows
    const aqui = await agg(d)
    const antes = await agg(modelo.datasets)
    const totalAqui = R.leads || 1
    const totalAntes = (await c.query('select count(*)::int as n from leadscore.leads where dataset_id = any($1)', [modelo.datasets])).rows[0].n || 1
    for (const q of respostasPerfil) {
      const hist = new Map(antes.filter((r: any) => r.pergunta === q).map((r: any) => [r.resposta, r.leads / totalAntes]))
      perfil.push({
        pergunta: q,
        respostas: aqui
          .filter((r: any) => r.pergunta === q)
          .sort((a: any, b: any) => b.leads - a.leads)
          .map((r: any) => ({
            resposta: r.resposta,
            leads: r.leads,
            pct: arr4(r.leads / totalAqui),
            pct_historico: hist.has(r.resposta) ? arr4(hist.get(r.resposta)) : null,
            prob_media: arr4(r.prob_media),
          })),
      })
    }
  }

  // --- campanha, criativo, público (UTMs guardadas como extras) ---
  const dimensoes: { chave: string; titulo: string }[] = [
    { chave: 'utm_campaign', titulo: 'Campanha' },
    { chave: 'utm_content', titulo: 'Criativo / anúncio' },
    { chave: 'utm_medium', titulo: 'Público / conjunto' },
  ]
  const porDimensao: unknown[] = []
  for (const dim of dimensoes) {
    const { rows } = await c.query(
      `select extras ->> $2 as valor, count(*)::int as leads, avg(${P})::float8 as prob_media,
              avg(score)::float8 as score_medio,
              (count(*) filter (where classe = 'hot'))::float8 / count(*) as pct_hot
         from leadscore.leads where dataset_id = $1 and nullif(extras ->> $2, '') is not null
        group by 1 having count(*) >= 30 order by 2 desc limit 15`,
      [dataset.id, dim.chave],
    )
    if (rows.length) {
      porDimensao.push({
        chave: dim.chave,
        titulo: dim.titulo,
        itens: rows.map((r: any) => ({
          valor: r.valor, leads: r.leads, prob_media: arr4(r.prob_media),
          score_medio: Math.round(r.score_medio), pct_hot: arr4(r.pct_hot),
        })),
      })
    }
  }

  // --- melhores leads (para o comercial agir já) ---
  const topLeads = (
    await c.query(
      `select nome, email, telefone_fmt, score, ${P}::float8 as prob,
              coalesce(nullif(respostas ->> $2, ''), '') as origem
         from leadscore.leads where dataset_id = $1 and prob is not null
        order by prob desc, linha limit 15`,
      [dataset.id, perguntaOrigem ?? ''],
    )
  ).rows.map((l: any) => ({ nome: l.nome, email: l.email, telefone: l.telefone_fmt, score: l.score, prob: arr4(l.prob), origem: l.origem }))

  // quanto das vendas do histórico veio de gente que estava na lista de leads (o resto comprou por outros caminhos)
  const { rows: cob } = await c.query(
    `select coalesce(sum((a.stats ->> 'total_compras')::float8), 0) as da_lista,
            coalesce(sum((a.meta ->> 'compradores_banco')::float8), 0) as totais,
            min((a.stats ->> 'total_compras')::float8 / nullif((a.meta ->> 'compradores_banco')::float8, 0)) as cob_min,
            max((a.stats ->> 'total_compras')::float8 / nullif((a.meta ->> 'compradores_banco')::float8, 0)) as cob_max
       from (select distinct on (dataset_id) stats, meta from leadscore.analises
              where dataset_id = any($1) order by dataset_id, criada_em desc) a`,
    [modelo.datasets],
  )
  const cobertura = Number(cob[0].totais) ? Number(cob[0].da_lista) / Number(cob[0].totais) : null
  // a cobertura varia muito entre lançamentos (41%–77%): por isso as vendas totais saem como faixa, não como ponto
  const cobMin = Number(cob[0].cob_min) || null
  const cobMax = Number(cob[0].cob_max) || null
  // faixa da conversão de um lançamento novo: intervalo de previsão de efeitos aleatórios (DerSimonian-Laird) sobre o
  // logit da taxa de cada base de treino. Com poucas bases o intervalo é largo de propósito: min–max das bases subestima.
  const [convMin, convMax] = intervaloNovoLancamento(
    ((modelo.stats.bases || []) as { leads: number; compras: number }[]).map((b) => ({ n: Number(b.leads), x: Number(b.compras) })),
  )

  const probTreino = Number(modelo.stats.prob_media_treino) || 0
  const razao = probTreino ? R.prob_media / probTreino : null
  const veredito = razao === null ? 'indefinido' : razao >= 1.1 ? 'acima' : razao <= 0.9 ? 'abaixo' : 'em_linha'

  return json({
    base: { id: dataset.id, nome: dataset.nome, total_linhas: dataset.total_linhas },
    modelo: { id: modelo.id, nome: modelo.nome, criado_em: modelo.criado_em },
    resumo: {
      leads: R.leads,
      responderam: R.responderam,
      pct_responderam: arr4(R.responderam / R.leads),
      prob_media: arr4(R.prob_media),
      compras_esperadas: Math.round(R.compras_esperadas),
      cobertura_historica: cobertura === null ? null : arr4(cobertura),
      vendas_totais_estimadas: cobertura ? Math.round(R.compras_esperadas / cobertura) : null,
      vendas_totais_faixa: cobMin && cobMax ? [Math.round(R.compras_esperadas / cobMax), Math.round(R.compras_esperadas / cobMin)] : null,
      conversao_faixa_historica: convMin !== null && convMax !== null ? [arr4(convMin), arr4(convMax)] : null,
      compras_faixa_historica: convMin !== null && convMax !== null ? [Math.round(R.leads * convMin), Math.round(R.leads * convMax)] : null,
      calibracao: delta === 0 ? null : { taxa_alvo: arr4(taxaAlvo), prob_media_antes: arr4(probMediaAntes), delta_logit: arr4(delta) },
      score_medio: Math.round(R.score_medio),
      teto_prob: teto < 1 ? teto : null,
      classes: { hot: R.hot, warm: R.warm, cold: R.cold },
      pct_hot: arr4(R.hot / R.leads),
      pct_hot_historico: 0.2,
      compradores_conhecidos: R.compradores,
    },
    comparacao: {
      prob_media_historico: arr4(probTreino),
      razao: razao === null ? null : Math.round(razao * 100) / 100,
      veredito,
      bases_treino: (modelo.stats.bases || []).map((b: any) => ({
        nome: b.nome, leads: b.leads, compras: b.compras, taxa_base: b.taxa_base,
      })),
    },
    faixas,
    por_origem: porOrigem,
    por_dimensao: porDimensao,
    perfil,
    top_leads: topLeads,
    por_dia: porDia,
  })
}

// --------------------------------------------------------------- roteador ---

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const rota = url.pathname.replace(/^\/api\/?/, '')
  const metodo = req.method.toUpperCase()
  const partes = rota.split('/').filter(Boolean)

  if (rota === 'health') {
    try {
      const agora = await comBanco(env, async (c) => (await c.query('select now() as t')).rows[0].t)
      return json({ ok: true, banco: true, agora, mock_buyers: false })
    } catch (e) {
      return json({ ok: false, banco: false, detail: (e as Error).message }, 503)
    }
  }

  // token só é exigido se o secret estiver configurado (em dev, fica aberto).
  // aceita na query também porque baixar CSV é navegação, que não manda header.
  if (env.PAINEL_TOKEN) {
    const informado = req.headers.get('x-painel-token') || url.searchParams.get('token')
    if (informado !== env.PAINEL_TOKEN) return erro(401, 'Token do painel inválido ou ausente.')
  }

  // o export mantém a conexão aberta durante o streaming — fora do comBanco
  if (partes[0] === 'analises' && partes.length === 4 && partes[2] === 'leads' && partes[3] === 'export' && metodo === 'GET') {
    return rotaExport(env, partes[1], url)
  }

  if (partes[0] === 'modelos' && partes.length === 3 && partes[2] === 'export' && metodo === 'GET') {
    return rotaExportModelo(env, partes[1], url)
  }

  return comBanco(env, async (c) => {
    if (rota === 'turmas' && metodo === 'GET') return rotaTurmas(c)

    if (rota === 'captacao' && metodo === 'POST') return rotaCaptacao(c, req)

    if (partes[0] === 'datasets') {
      if (partes.length === 1 && metodo === 'GET') return rotaListarDatasets(c)
      if (partes.length === 1 && metodo === 'POST') return rotaCriarDataset(c, req)
      if (partes.length === 2 && metodo === 'DELETE') return rotaApagarDataset(c, partes[1])
      if (partes.length === 3 && partes[2] === 'linhas' && metodo === 'POST') return rotaLinhas(c, req, partes[1])
      if (partes.length === 3 && partes[2] === 'concluir' && metodo === 'POST') return rotaConcluirDataset(c, req, partes[1])
      if (partes.length === 3 && partes[2] === 'arquivo' && metodo === 'POST') return rotaGuardarArquivo(c, req, partes[1])
      if (partes.length === 3 && partes[2] === 'arquivo' && metodo === 'GET') return rotaBaixarArquivo(c, partes[1])
    }

    if (partes[0] === 'modelos') {
      if (partes.length === 1 && metodo === 'GET') return rotaListarModelos(c)
      if (partes.length === 1 && metodo === 'POST') return rotaCriarModelo(c, req)
      if (partes.length === 2 && metodo === 'GET') return rotaModelo(c, partes[1])
      if (partes.length === 3 && partes[2] === 'pesos' && metodo === 'GET') return rotaPesosDoModelo(c, partes[1])
    }

    if (partes[0] === 'analises') {
      if (partes.length === 1 && metodo === 'GET') return rotaListarAnalises(c)
      if (partes.length === 1 && metodo === 'POST') return rotaCriarAnalise(c, req)
      if (partes.length === 2 && metodo === 'GET') return rotaAnalise(c, partes[1])
      if (partes.length === 3 && partes[2] === 'leads' && metodo === 'GET') return rotaLeads(c, partes[1], url)
    }

    return erro(404, `Rota não encontrada: ${metodo} /api/${rota}`)
  })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,x-painel-token,x-conteudo-gzip',
          'access-control-max-age': '86400',
        },
      })
    }

    if (url.pathname.startsWith('/api')) {
      try {
        const resp = await api(req, env, url)
        resp.headers.set('access-control-allow-origin', '*')
        return resp
      } catch (e) {
        if (e instanceof ErroHttp) return erro(e.status, e.message)
        return erro(500, `Erro inesperado: ${(e as Error).message}`)
      }
    }

    // qualquer outra coisa é o front buildado
    return env.ASSETS.fetch(req)
  },
}
