// Divide listas de leads (CSV de captação) em um arquivo por OAB × produto, classificando CADA lead
// pelo que a campanha (utm_campaign) diz, não pela lista onde ele veio parar.
//
//   node db/dev/dividir-leads.mjs lista1.csv lista2.csv ... [--saida pasta]
//
// Por quê: uma lista de captação acaba recebendo leads de campanhas de OUTROS lançamentos
// (ex.: a lista do 180D da OAB 48 tem 685 leads de campanha do 40D da OAB 47, que quase não compram o 180D).
//
// Regras (nada é chutado):
//  - campanha com "<n>d-oab<nn>" ou "oab<nn>_<n>d" (ex.: 1f-180d-oab48_ps-06-26) → OAB nn, produto nD
//  - campanha com "oab<nn>" sem produto (ex.: rn-oab46_ev-04-26_…)               → OAB nn, produto SEM-PRODUTO
//  - campanha com "tribunais" / "enam"                                            → produto TRIBUNAIS / ENAM
//  - campanha vazia, só números (id do anúncio), "{{campaign.name}}" ou outra     → lançamento da PRÓPRIA LISTA
//    (a coluna "classificado_por" diz "lista" nesses casos; nos demais, "campanha")
// O lançamento da lista é lido do nome do arquivo (ex.: "Leads 180D - OAB 48 …" → OAB 48, 180D;
// "…Tribunais…" → TRIBUNAIS). Se não der para ler, o script para e pede para renomear.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import Papa from 'papaparse'

const args = process.argv.slice(2)
const iS = args.indexOf('--saida')
const arquivos = args.filter((a, i) => !a.startsWith('--') && (iS < 0 || i !== iS + 1)).map((a) => a.replace(/^~/, homedir()))
if (!arquivos.length) { console.error('Uso: node db/dev/dividir-leads.mjs lista1.csv lista2.csv ... [--saida pasta]'); process.exit(1) }
const saida = (iS >= 0 ? args[iS + 1] : path.join(path.dirname(arquivos[0]), 'leads-por-oab-produto')).replace(/^~/, homedir())
if (existsSync(saida)) { console.error(`A pasta ${saida} já existe — apague ou escolha outra, não sobrescrevo.`); process.exit(1) }

/** Lançamento que o nome do arquivo declara. */
function lancamentoDaLista(arquivo) {
  const n = path.basename(arquivo).toLowerCase()
  if (n.includes('tribunais')) return { oab: '-', produto: 'TRIBUNAIS' }
  const oab = n.match(/oab\s*(\d+)/)?.[1]
  const prod = n.match(/(\d+)\s*d\b/)?.[1]
  if (oab && prod) return { oab, produto: `${prod}D` }
  throw new Error(`Não consegui ler OAB e produto do nome "${path.basename(arquivo)}". Renomeie (ex.: "Leads 180D - OAB 48.csv").`)
}

/** Lançamento que a campanha declara, ou null. */
function lancamentoDaCampanha(campanha) {
  const c = (campanha || '').trim().toLowerCase()
  if (!c) return null
  let m = c.match(/(\d+)d[-_ ]*oab\s*(\d+)/)
  if (m) return { oab: m[2], produto: `${m[1]}D` }
  m = c.match(/oab\s*(\d+)[-_ ]*(\d+)d/)
  if (m) return { oab: m[1], produto: `${m[2]}D` }
  m = c.match(/oab\s*(\d+)/)
  if (m) return { oab: m[1], produto: 'SEM-PRODUTO' }
  if (c.includes('tribunais')) return { oab: '-', produto: 'TRIBUNAIS' }
  if (c.includes('enam')) return { oab: '-', produto: 'ENAM' }
  return null
}

const grupos = new Map()
const colunas = []
for (const arquivo of arquivos) {
  const lista = lancamentoDaLista(arquivo)
  const csv = Papa.parse(readFileSync(arquivo, 'utf8').replace(/^﻿/, ''), { header: true, skipEmptyLines: true })
  const colCamp = csv.meta.fields.find((f) => f.trim().toLowerCase() === 'utm_campaign')
  if (!colCamp) throw new Error(`${path.basename(arquivo)}: coluna utm_campaign não encontrada`)
  for (const f of csv.meta.fields) if (!colunas.includes(f)) colunas.push(f)
  const nomeLista = path.basename(arquivo, '.csv')
  for (const l of csv.data) {
    const porCampanha = lancamentoDaCampanha(l[colCamp])
    const k = porCampanha || lista
    const chave = `${k.oab}|${k.produto}`
    if (!grupos.has(chave)) grupos.set(chave, { ...k, linhas: [], listas: new Map(), porCampanha: 0, porLista: 0 })
    const g = grupos.get(chave)
    g.linhas.push({ ...l, lista_origem: nomeLista, classificado_por: porCampanha ? 'campanha' : 'lista' })
    g.listas.set(nomeLista, (g.listas.get(nomeLista) || 0) + 1)
    porCampanha ? g.porCampanha++ : g.porLista++
  }
}

mkdirSync(saida, { recursive: true })
const campos = [...colunas, 'lista_origem', 'classificado_por']
const ordem = (g) => [g.oab === '-' ? 999 : Number(g.oab), parseInt(g.produto) || 999]
const lista = [...grupos.values()].sort((a, b) => { const [x, y] = [ordem(a), ordem(b)]; return x[0] - y[0] || x[1] - y[1] || a.produto.localeCompare(b.produto) })

const resumo = []
for (const g of lista) {
  const nome = g.oab === '-' ? `${g.produto}.csv` : `OAB${g.oab}_${g.produto}.csv`
  writeFileSync(path.join(saida, nome), '﻿' + Papa.unparse(g.linhas, { columns: campos }))
  const colEmail = campos.find((f) => f.trim().toLowerCase() === 'email')
  const emails = new Set(g.linhas.map((l) => (l[colEmail] || '').trim().toLowerCase()).filter(Boolean))
  resumo.push({
    oab: g.oab, produto: g.produto, arquivo: nome, linhas: g.linhas.length, emails_unicos: emails.size,
    classificados_pela_campanha: g.porCampanha, atribuidos_pela_lista: g.porLista,
    listas_de_origem: [...g.listas].map(([k, v]) => `${k} (${v})`).join(' | '),
  })
}
writeFileSync(path.join(saida, 'resumo.csv'), '﻿' + Papa.unparse(resumo))
console.log(`${arquivos.length} listas → ${lista.length} arquivos em ${saida}\n`)
console.table(resumo.map((r) => ({ OAB: r.oab, produto: r.produto, linhas: r.linhas, 'e-mails únicos': r.emails_unicos, 'por campanha': r.classificados_pela_campanha, 'pela lista': r.atribuidos_pela_lista })))
console.log('\nDe onde vieram:'); for (const r of resumo) console.log(`  ${r.oab === '-' ? '' : 'OAB' + r.oab + ' '}${r.produto}: ${r.listas_de_origem}`)
