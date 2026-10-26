// Divide a planilha de vendas da Hotmart (CSV com ";") em um arquivo por OAB × produto,
// com as MESMAS colunas do original, mais um resumo.csv.
//
//   node db/dev/dividir-vendas.mjs ~/Downloads/vendas-2026.csv [pasta-de-saida]
//
// Regras (nada é chutado):
//  - Produto  = coluna "Produto" ("VDE 1ª Fase OAB - 180D" → 180D; "... Anual (...)" → Anual).
//  - OAB      = primeiro "OAB <n>" no "Nome deste preço" (ex.: "Turma 180 Dias OAB 48 | Oferta Aluno 90D - OAB 47"
//               é da OAB 48; a 47 só diz de onde o aluno veio).
//  - Pacote anual ("OABs 46, 47 e 48") não tem uma OAB só → OAB "ANUAL".
//  - Preço sem OAB no nome → OAB "SEM-OAB" (para decidir à mão, não adivinho).
//  - Vendas de teste ("Nome deste preço" = teste) ficam de fora e são contadas no resumo.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import Papa from 'papaparse'

const entrada = (process.argv[2] || '').replace(/^~/, homedir())
if (!entrada) { console.error('Uso: node db/dev/dividir-vendas.mjs <vendas.csv> [pasta-de-saida]'); process.exit(1) }
const saida = (process.argv[3] || path.join(path.dirname(entrada), `${path.basename(entrada, '.csv')}-por-oab-produto`)).replace(/^~/, homedir())
if (existsSync(saida)) { console.error(`A pasta ${saida} já existe — apague ou escolha outra, não sobrescrevo.`); process.exit(1) }

const csv = Papa.parse(readFileSync(entrada, 'utf8').replace(/^﻿/, ''), { header: true, delimiter: ';', skipEmptyLines: true })
const campos = csv.meta.fields
const col = (nome) => { if (!campos.includes(nome)) throw new Error(`Coluna não encontrada: ${nome}`); return nome }
const C = {
  produto: col('Produto'), preco: col('Nome deste preço'), email: col('Email do(a) Comprador(a)'),
  bruto: col('Faturamento bruto (sem impostos)'), moeda: col('Moeda de compra'), data: col('Data da transação'),
}

function classificar(l) {
  const preco = (l[C.preco] || '').trim()
  if (preco.toLowerCase() === 'teste') return { teste: true }
  const produto = /anual/i.test(l[C.produto]) ? 'Anual' : (l[C.produto].match(/-\s*(\d+D)\s*$/i)?.[1] || l[C.produto].trim()).toUpperCase()
  let oab
  if (/OABs\s/i.test(preco) || /anual/i.test(l[C.produto])) oab = 'ANUAL'
  else oab = preco.match(/OAB\s*(\d+)/i)?.[1] || 'SEM-OAB'
  return { produto, oab }
}

const grupos = new Map()
let teste = 0
for (const l of csv.data) {
  const k = classificar(l)
  if (k.teste) { teste++; continue }
  const chave = `${k.oab}|${k.produto}`
  if (!grupos.has(chave)) grupos.set(chave, { oab: k.oab, produto: k.produto, linhas: [] })
  grupos.get(chave).linhas.push(l)
}

mkdirSync(saida, { recursive: true })
const ordem = (g) => [g.oab === 'ANUAL' ? 998 : g.oab === 'SEM-OAB' ? 999 : Number(g.oab), parseInt(g.produto) || 999]
const lista = [...grupos.values()].sort((a, b) => { const [x, y] = [ordem(a), ordem(b)]; return x[0] - y[0] || x[1] - y[1] })

const num = (v) => Number(String(v).replace(',', '.')) || 0
const resumo = []
for (const g of lista) {
  const nome = `${g.oab === 'ANUAL' || g.oab === 'SEM-OAB' ? g.oab : `OAB${g.oab}`}_${g.produto}.csv`
  writeFileSync(path.join(saida, nome), '﻿' + Papa.unparse(g.linhas, { delimiter: ';', columns: campos }))
  const emails = new Set(g.linhas.map((l) => l[C.email].trim().toLowerCase()))
  const brl = g.linhas.filter((l) => l[C.moeda] === 'BRL')
  const datas = g.linhas.map((l) => l[C.data].slice(0, 10).split('/').reverse().join('-')).sort()
  resumo.push({
    oab: g.oab, produto: g.produto, arquivo: nome, vendas: g.linhas.length, compradores_unicos: emails.size,
    faturamento_bruto_brl: brl.reduce((s, l) => s + num(l[C.bruto]), 0).toFixed(2),
    vendas_em_outra_moeda: g.linhas.length - brl.length, primeira_venda: datas[0], ultima_venda: datas.at(-1),
  })
}
writeFileSync(path.join(saida, 'resumo.csv'), '﻿' + Papa.unparse(resumo, { delimiter: ';' }))

console.log(`${csv.data.length} linhas → ${lista.length} arquivos em ${saida}  (${teste} vendas de teste ignoradas)\n`)
console.table(resumo.map((r) => ({ OAB: r.oab, produto: r.produto, vendas: r.vendas, compradores: r.compradores_unicos, 'R$ bruto': Number(r.faturamento_bruto_brl).toLocaleString('pt-BR'), primeira: r.primeira_venda, ultima: r.ultima_venda })))
