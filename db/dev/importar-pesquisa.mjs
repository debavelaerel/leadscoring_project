// Importa um CSV de pesquisa de leads pela API local, igual ao fluxo da tela
// "Nova análise" (cria a base → manda as linhas em lotes → conclui).
//
// Uso:
//   node db/dev/importar-pesquisa.mjs <csv> --oab 47 --curso 120D [--nome "OAB 47 — 120D"]
//
// As perguntas são padronizadas (ver PADRONIZAR) para que as bases de
// lançamentos diferentes tenham o mesmo nome de pergunta e o modelo
// combinado consiga compará-las.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import Papa from 'papaparse'

const API = process.env.API_URL || 'http://localhost:8787/api'
const LOTE = 500

// nome no CSV (normalizado) → nome padrão da pergunta
const PADRONIZAR = [
  [/^(qual a sua )?idade\??$/, 'Idade'],
  [/^é bacharel ou estudante de direito ?\??$/, 'É bacharel ou estudante de Direito?'],
  [/^já fez a prova da oab antes\??$/, 'Já fez a prova da OAB antes?'],
  [/^há quanto tempo estuda pra oab\??$/, 'Há quanto tempo estuda pra OAB?'],
  [/^é ou já foi aluno vde oab\??$/, 'É ou já foi aluno VDE OAB?'],
  [/^há quanto tempo conhece o método vde\??$/, 'Há quanto tempo conhece o Método VDE?'],
  [/^(ao final do aulão gratuito.*|pretende entrar na turma.*)$/, 'Pretende entrar na turma do lançamento?'],
]
// texto aberto (milhares de respostas distintas): não entra no modelo
const IGNORAR_PERGUNTAS = /se você fosse fazer um curso pago/i

const args = process.argv.slice(2)
const arquivo = args[0]?.startsWith('--') ? undefined : args[0]
const opcao = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const oab = Number(opcao('oab'))
const curso = opcao('curso')
if (!arquivo || !oab || !curso) {
  console.error('Uso: node db/dev/importar-pesquisa.mjs <csv> --oab 47 --curso 120D [--nome "..."]')
  process.exit(1)
}

const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const padrao = (col) => PADRONIZAR.find(([re]) => re.test(norm(col)))?.[1]

async function chamar(metodo, caminho, corpo) {
  const r = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  })
  const json = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${metodo} ${caminho} → ${r.status}: ${json.detail || JSON.stringify(json)}`)
  return json
}

const bruto = readFileSync(arquivo)
const csv = Papa.parse(bruto.toString('utf8').replace(/^﻿/, ''), { header: true, skipEmptyLines: true })
if (csv.errors.length) console.warn(`aviso: ${csv.errors.length} avisos de leitura (ex.: ${csv.errors[0].message})`)

const colunas = csv.meta.fields
const achar = (re) => colunas.find((c) => re.test(norm(c)))
const perguntas = colunas.filter((c) => padrao(c))
const ignoradas = colunas.filter((c) => IGNORAR_PERGUNTAS.test(c))
console.log(`Arquivo: ${basename(arquivo)} — ${csv.data.length} linhas`)
console.log('Perguntas usadas:', perguntas.map((c) => `${c} → ${padrao(c)}`))
if (ignoradas.length) console.log('Ignoradas (texto aberto):', ignoradas)

// renomeia as colunas das perguntas para o nome padrão
// a origem do lead (utm_source) entra como uma pergunta a mais: melhora o modelo
// (AUC +0,02) e vem do cadastro, não da pesquisa
const ORIGEM = 'Origem do lead (utm_source)'
// o nome da utm_source muda de um lançamento para outro (pago/organico numa, meta-ads/whatsapp... noutra), então
// o modelo usa o GRUPO, que é comparável entre lançamentos. Validado fora da amostra: AUC médio 0,725 → 0,750.
const ORIGEM_GRUPO = 'Origem do lead (grupo)'
const GRUPOS_ORIGEM = {
  'meta-ads': 'pago', 'google-ads': 'pago', pago: 'pago',
  instagram: 'organico', site: 'organico', organico: 'organico', org: 'organico',
  whatsapp: 'base propria', email: 'base propria',
}
const grupoOrigem = (o) => (o ? GRUPOS_ORIGEM[o] ?? 'outro' : '')
const colOrigem = args.includes('--sem-origem') ? undefined : colunas.find((c) => norm(c) === 'utm_source')
const renomeadas = csv.data.map((l) => {
  const o = { ...l }
  for (const c of perguntas) { o[padrao(c)] = l[c]; if (padrao(c) !== c) delete o[c] }
  if (colOrigem) {
    o[ORIGEM] = (l[colOrigem] ?? '').trim().toLowerCase()
    o[ORIGEM_GRUPO] = grupoOrigem(o[ORIGEM])
  }
  return o
})
const mapeamento = {
  email: achar(/^e-?mail$/),
  telefone: achar(/^(telefone|celular|whatsapp)$/),
  nome: achar(/^nome$/) ?? null,
  data: achar(/^(created_at|data)$/) ?? null,
  perguntas: [...perguntas.map(padrao), ...(colOrigem ? [ORIGEM, ORIGEM_GRUPO] : [])],
  // campanha, criativo e público: só análise (tela Captação), fora do modelo
  extras: colunas.filter((c) => ['utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].includes(norm(c))),
}

// só leads únicos: um por e-mail (sem e-mail, por telefone). Entre repetidos
// fica o cadastro com mais perguntas respondidas; empate, o mais antigo.
const nomesPerguntas = mapeamento.perguntas
const respondidas = (l) => nomesPerguntas.filter((p) => (l[p] ?? '').trim()).length
const chaveLead = (l) =>
  (l[mapeamento.email] ?? '').trim().toLowerCase() ||
  (l[mapeamento.telefone] ?? '').replace(/\D/g, '') ||
  null
const unicos = new Map()
let semChave = 0
for (const l of renomeadas) {
  const k = chaveLead(l)
  if (!k) { semChave++; continue }
  const atual = unicos.get(k)
  if (!atual || respondidas(l) > respondidas(atual)) unicos.set(k, l)
}
const linhas = [...unicos.values()]
console.log(`Únicos: ${linhas.length} de ${renomeadas.length} (removidos ${renomeadas.length - linhas.length - semChave} repetidos, ${semChave} sem e-mail nem telefone)`)
console.log('Mapeamento:', mapeamento)

const nome = opcao('nome') || `OAB ${oab} — ${curso}`
const criado = await chamar('POST', '/datasets', {
  nome, arquivo_nome: basename(arquivo), bytes: bruto.length,
  hash: createHash('sha256').update(bruto).digest('hex'),
  oab, curso, colunas: [...new Set(Object.keys(linhas[0]))], mapeamento,
}).catch((e) => { console.error(e.message); process.exit(1) })

const id = criado.id
for (let i = 0; i < linhas.length; i += LOTE) {
  await chamar('POST', `/datasets/${id}/linhas`, { inicio: i, linhas: linhas.slice(i, i + LOTE) })
  process.stdout.write(`\r${Math.min(i + LOTE, linhas.length)}/${linhas.length}`)
}
await chamar('POST', `/datasets/${id}/concluir`, { total_linhas: linhas.length })
console.log(`\nPronto: base "${nome}" (${id}) com ${linhas.length} leads.`)
