/**
 * Cliente da API do Lead Score.
 *
 * Em dev o Vite faz proxy de /api pro `wrangler dev` (porta 8787);
 * em produção o próprio Worker serve o front, então o caminho é o mesmo.
 *
 * Se o Worker estiver com PAINEL_TOKEN configurado, guardamos o token no
 * navegador e mandamos no header. Sem token configurado (dev), tudo passa.
 */

import Papa from 'papaparse'

const CHAVE_TOKEN = 'leadscore.token'

/** Tamanho do pedaço de CSV enviado por requisição (bytes). */
const TAMANHO_LOTE_BYTES = 64 * 1024

export const getToken = () => localStorage.getItem(CHAVE_TOKEN) || ''
export const setToken = (t) => localStorage.setItem(CHAVE_TOKEN, t || '')

function cabecalhos(extra = {}) {
  const token = getToken()
  return { ...(token ? { 'x-painel-token': token } : {}), ...extra }
}

async function checar(resp) {
  if (resp.status === 401) {
    const informado = window.prompt('Token do painel:')
    if (informado) {
      setToken(informado.trim())
      throw new Error('Token salvo — tente de novo.')
    }
  }
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`
    let corpo = null
    const bruto = await resp.text().catch(() => '')
    try {
      corpo = JSON.parse(bruto)
      msg = corpo.detail || msg
    } catch {
      // corpo não-JSON (ex.: o proxy do Vite quando a API está fora do ar):
      // mostra o texto em vez de deixar só o número do erro
      if (bruto.trim()) msg = `${msg} — ${bruto.trim().slice(0, 200)}`
    }
    const e = new Error(msg)
    e.status = resp.status
    e.corpo = corpo
    throw e
  }
  return resp.json()
}

const pegar = (url) => fetch(url, { headers: cabecalhos() }).then(checar)

const postar = (url, corpo) =>
  fetch(url, {
    method: 'POST',
    headers: cabecalhos({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(corpo),
  }).then(checar)

// --------------------------------------------------------------- turmas ----

export const getTurmas = () => pegar('/api/turmas')

// ---------------------------------------------------------------- bases ----

export const getDatasets = () => pegar('/api/datasets')

export const apagarDataset = (id) =>
  fetch(`/api/datasets/${id}`, { method: 'DELETE', headers: cabecalhos() }).then(checar)

async function sha256(arquivo) {
  try {
    const buffer = await arquivo.arrayBuffer()
    const hash = await crypto.subtle.digest('SHA-256', buffer)
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null // contexto sem crypto.subtle (http em rede local) — segue sem dedupe
  }
}

/** Comprime o CSV antes de enviar — 9,5 MB viram ~1,5 MB. */
async function comprimir(arquivo) {
  if (typeof CompressionStream === 'undefined') return { corpo: arquivo, gzip: false }
  try {
    const fluxo = arquivo.stream().pipeThrough(new CompressionStream('gzip'))
    return { corpo: await new Response(fluxo).blob(), gzip: true }
  } catch {
    return { corpo: arquivo, gzip: false }
  }
}

export const urlArquivoOriginal = (datasetId) => {
  const token = getToken()
  return `/api/datasets/${datasetId}/arquivo${token ? `?token=${encodeURIComponent(token)}` : ''}`
}

/**
 * Sobe uma base nova: o CSV original (comprimido) e as linhas normalizadas,
 * em lotes — tudo pro schema `leadscore` no banco.
 *
 * @param onProgresso ({etapa, enviadas, total, pct}) => void
 */
export async function enviarBase({ arquivo, mapeamento, oab, curso, nome, colunas, onProgresso = () => {} }) {
  onProgresso({ etapa: 'preparando', pct: 0 })
  const hash = await sha256(arquivo)

  const criado = await postar('/api/datasets', {
    nome: nome || arquivo.name,
    arquivo_nome: arquivo.name,
    bytes: arquivo.size,
    hash,
    oab,
    curso,
    colunas: colunas || [],
    mapeamento,
  })

  const datasetId = criado.id

  // 1) guarda o CSV original (comprimido) junto da base
  onProgresso({ etapa: 'arquivo', pct: 5 })
  try {
    const { corpo, gzip } = await comprimir(arquivo)
    await fetch(`/api/datasets/${datasetId}/arquivo`, {
      method: 'POST',
      headers: cabecalhos({ 'Content-Type': 'application/octet-stream', 'x-conteudo-gzip': gzip ? '1' : '0' }),
      body: corpo,
    })
  } catch { /* o original é um extra: a análise não depende dele */ }

  // 2) linhas em lotes — o parse acontece aqui no navegador
  let enviadas = 0
  const totalBytes = arquivo.size || 1

  await new Promise((resolve, reject) => {
    Papa.parse(arquivo, {
      header: true,
      skipEmptyLines: true,
      // ~200 linhas por lote. O Worker no plano Free tem 10ms de CPU por
      // requisição; se aparecer "exceeded CPU limit", baixe para 32*1024
      // (ou ative o Workers Paid, que dá 30s).
      chunkSize: TAMANHO_LOTE_BYTES,
      chunk: async (resultado, parser) => {
        const linhas = resultado.data
        if (!linhas.length) return
        parser.pause()
        try {
          await postar(`/api/datasets/${datasetId}/linhas`, { inicio: enviadas, linhas })
          enviadas += linhas.length
          const lidos = resultado.meta?.cursor || 0
          onProgresso({
            etapa: 'linhas',
            enviadas,
            pct: Math.min(95, 5 + Math.round((lidos / totalBytes) * 90)),
          })
          parser.resume()
        } catch (e) {
          parser.abort()
          reject(e)
        }
      },
      complete: () => resolve(),
      error: (e) => reject(new Error(e?.message || 'Falha ao ler o CSV.')),
    })
  })

  await postar(`/api/datasets/${datasetId}/concluir`, { total_linhas: enviadas })
  onProgresso({ etapa: 'concluido', enviadas, pct: 100 })

  return { id: datasetId, total_linhas: enviadas }
}

// -------------------------------------------------------------- análises ----

export const criarAnalise = ({ dataset_id, turmas, oab, curso, nome }) =>
  postar('/api/analises', { dataset_id, turmas, oab, curso, nome })

// ---------------------------------------------------------------- modelos ----

export const getModelos = () => pegar('/api/modelos')

export const getModelo = (id) => pegar(`/api/modelos/${id}`)

/** Treina um modelo combinando várias bases. */
export const criarModelo = ({ nome, datasets, perguntas }) =>
  postar('/api/modelos', { nome, datasets, perguntas })

/** JSON de pesos — é o arquivo que alimenta o Optimiz. */
export function urlPesosModelo(id) {
  const token = getToken()
  return `/api/modelos/${id}/pesos${token ? `?token=${encodeURIComponent(token)}` : ''}`
}

export const getAnalises = () => pegar('/api/analises')

export const getAnalise = (id) => pegar(`/api/analises/${id}`)

export function getLeads(id, { classe, busca, semCompradores, pagina = 1, porPagina = 50 } = {}) {
  const qs = new URLSearchParams({ pagina, por_pagina: porPagina })
  if (classe) qs.set('classe', classe)
  if (busca) qs.set('busca', busca)
  if (semCompradores) qs.set('sem_compradores', 'true')
  return pegar(`/api/analises/${id}/leads?${qs}`)
}

export function urlExport(id, classe, semCompradores) {
  const qs = new URLSearchParams()
  if (classe) qs.set('classe', classe)
  if (semCompradores) qs.set('sem_compradores', 'true')
  const token = getToken()
  if (token) qs.set('token', token) // download é navegação: não dá pra mandar header
  const s = qs.toString()
  return `/api/analises/${id}/leads/export${s ? `?${s}` : ''}`
}
