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
import { Mapeamento, prepararLead } from './etl'
import {
  Agregado, AgregadoBase, ResumoBase,
  calcularModelo, calcularModeloCombinado, MAX_RESPOSTAS,
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
      l.tel_chaves, l.data_lead, JSON.stringify(l.respostas), l.respondeu,
    ]),
  )

  await c.query(
    `insert into leadscore.leads
       (dataset_id, linha, nome, email, telefone_fmt, tel_chaves, data_lead, respostas, respondeu)
     values ${texto}
     on conflict (dataset_id, linha) do update
        set nome = excluded.nome, email = excluded.email,
            telefone_fmt = excluded.telefone_fmt, tel_chaves = excluded.tel_chaves,
            data_lead = excluded.data_lead, respostas = excluded.respostas,
            respondeu = excluded.respondeu`,
    valores,
  )
  return json({ inseridas: prontas.length })
}

async function rotaConcluirDataset(c: Client, req: Request, datasetId: string) {
  const corpo = (await req.json().catch(() => ({}))) as { total_linhas?: number; erro?: string }
  const { rows } = await c.query(
    `update leadscore.datasets
        set status = $2, erro = $3, total_linhas = $4
      where id = $1
      returning *`,
    [datasetId, corpo.erro ? 'erro' : 'pronto', corpo.erro ?? null, corpo.total_linhas ?? 0],
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
  const corpo = (await req.json()) as { nome?: string; datasets?: string[]; perguntas?: string[] }
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

  const aplicado = (
    await c.query('select leadscore.ls_aplicar_pesos_multi($1,$2) as r', [datasets, JSON.stringify(modelo.pesos)])
  ).rows[0].r as { faixas_score: unknown[]; classes: Record<string, unknown> }

  // --- validação -------------------------------------------------------------
  const validar = async (dataset: string, pesos: unknown) =>
    (await c.query('select leadscore.ls_validar($1,$2) as r', [dataset, JSON.stringify(pesos)])).rows[0].r

  const validacao: unknown[] = []
  for (const d of datasets) {
    const dentro = await validar(d, modelo.pesos)
    let fora = null
    if (datasets.length >= 2) {
      // treina sem esta base e pontua ela — acurácia honesta
      const treino = calcularModeloCombinado(
        agregados.filter((a) => a.dataset_id !== d),
        resumos.filter((r) => r.dataset_id !== d),
      )
      fora = await validar(d, treino.pesos)
    }
    validacao.push({ dataset_id: d, base: nomeDaBase.get(d), dentro_da_amostra: dentro, fora_da_amostra: fora })
  }

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
    parametros: modelo.parametros,
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

/** Os pesos em JSON — é este arquivo que alimenta o Optimiz. */
async function rotaPesosDoModelo(c: Client, id: string) {
  const { rows } = await c.query('select nome, perguntas, pesos, criado_em from leadscore.modelos where id = $1', [id])
  if (!rows.length) throw new ErroHttp(404, 'Modelo não encontrado.')
  const corpo = JSON.stringify(
    {
      modelo: rows[0].nome,
      gerado_em: rows[0].criado_em,
      parametros: { hot: 80, warm: 50, suavizacao: 5 },
      perguntas: rows[0].perguntas,
      pesos: rows[0].pesos,
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
    `select linha, nome, email, telefone_fmt, data_lead, respostas, respondeu, comprou, comprou_em, match_via, score, classe
       from leadscore.leads
      where ${where}
      order by score desc nulls last, linha asc
      limit $${valores.length + 1} offset $${valores.length + 2}`,
    [...valores, porPagina, (pagina - 1) * porPagina],
  )
  return json({ total, pagina, por_pagina: porPagina, leads: rows.map(leadPublico) })
}

const campoCsv = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
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

  return comBanco(env, async (c) => {
    if (rota === 'turmas' && metodo === 'GET') return rotaTurmas(c)

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
