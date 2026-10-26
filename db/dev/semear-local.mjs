#!/usr/bin/env node
/**
 * Ambiente local de teste — NÃO usar contra o RDS real.
 *
 * Cria um `plataforma1_espelho` de mentira (só as colunas que o projeto lê),
 * insere alunos sintéticos e grava dois CSVs de pesquisa em dados/ cuja
 * compra depende de algumas respostas (as outras são ruído de propósito).
 *
 *   DATABASE_URL=postgres://localhost:5432/leadscore_local node db/dev/semear-local.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { RAIZ } from '../../scripts/env.mjs'

const url = process.env.DATABASE_URL
if (!url || !/localhost|127\.0\.0\.1/.test(url)) {
  console.error('Recuso rodar: DATABASE_URL precisa apontar para localhost.')
  process.exit(1)
}

// gerador pseudoaleatório determinístico, pra o resultado ser reproduzível
let seed = 42
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = (arr, pesos) => {
  const tot = pesos.reduce((a, b) => a + b, 0)
  let r = rnd() * tot
  for (let i = 0; i < arr.length; i++) if ((r -= pesos[i]) <= 0) return arr[i]
  return arr[arr.length - 1]
}

const PERGUNTAS = {
  'Já foi reprovado na OAB?': { v: ['Sim, na 2ª fase', 'Sim, na 1ª fase', 'Nunca prestei'], p: [25, 35, 40], w: [1.1, 0.4, -0.7] },
  'Quanto tempo estuda por dia?': { v: ['Mais de 4h', '2 a 4h', '1 a 2h', 'Menos de 1h'], p: [15, 30, 30, 25], w: [0.9, 0.3, -0.2, -0.8] },
  'Qual sua renda mensal?': { v: ['Acima de 8 mil', '4 a 8 mil', '2 a 4 mil', 'Até 2 mil'], p: [10, 25, 35, 30], w: [0.5, 0.3, 0, -0.3] },
  'Está trabalhando?': { v: ['Estágio', 'CLT', 'Autônomo', 'Não'], p: [30, 25, 15, 30], w: [0, 0, 0, 0] }, // ruído
  'Como conheceu o curso?': { v: ['Instagram', 'YouTube', 'Indicação', 'Google'], p: [40, 25, 15, 20], w: [0, 0, 0, 0] }, // ruído
}

const NOMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Felipe', 'Gabi', 'Hugo', 'Iara', 'João', 'Karina', 'Lucas', 'Marina', 'Nuno', 'Olívia', 'Paulo']
const SOBRE = ['Silva', 'Souza', 'Lima', 'Costa', 'Rocha', 'Alves', 'Pereira', 'Gomes', 'Ribeiro', 'Martins']

function gerarLancamento(oab, n, base) {
  const leads = []
  const alunos = []
  for (let i = 0; i < n; i++) {
    const nome = `${NOMES[i % NOMES.length]} ${SOBRE[Math.floor(rnd() * SOBRE.length)]}`
    const email = `lead${oab}_${i}@exemplo.com`
    const tel = `11${9}${String(10000000 + Math.floor(rnd() * 89999999))}`
    const naoRespondeu = rnd() < 0.04
    const resp = {}
    let z = Math.log(base / (1 - base))
    for (const [q, d] of Object.entries(PERGUNTAS)) {
      const idx = d.v.indexOf(pick(d.v, d.p))
      resp[q] = naoRespondeu ? '' : d.v[idx]
      if (!naoRespondeu) z += d.w[idx]
    }
    leads.push({ nome, email, tel: `(11) ${tel.slice(2, 7)}-${tel.slice(7)}`, resp })
    if (rnd() < 1 / (1 + Math.exp(-z))) {
      const produto = pick(['90D', '40D', '60D'], [60, 25, 15])
      // 15% se matricularam com outro e-mail: só o telefone casa
      const emailAluno = rnd() < 0.15 ? `outro${oab}_${i}@exemplo.com` : email
      alunos.push({ oab, produto, nome, email: emailAluno, tel: `+55${tel}` })
    }
  }
  return { leads, alunos }
}

function csv({ leads }) {
  const cols = ['Nome', 'E-mail', 'Telefone', ...Object.keys(PERGUNTAS)]
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`
  return [cols.map(esc).join(','), ...leads.map((l) => [l.nome, l.email, l.tel, ...Object.keys(PERGUNTAS).map((q) => l.resp[q])].map(esc).join(','))].join('\n')
}

const lanc = [
  { oab: 46, ...gerarLancamento(46, 3000, 0.06) },
  { oab: 47, ...gerarLancamento(47, 4000, 0.07) },
]

fs.mkdirSync(path.join(RAIZ, 'dados'), { recursive: true })
for (const l of lanc) fs.writeFileSync(path.join(RAIZ, 'dados', `pesquisa_oab${l.oab}.csv`), csv(l))

const c = new pg.Client({ connectionString: url })
await c.connect()
await c.query(`
  create schema if not exists plataforma1_espelho;
  create table if not exists plataforma1_espelho.user_ (id serial primary key, role text, email text, cellphone text);
  create table if not exists plataforma1_espelho.classroom (id serial primary key, oab int, classroom_type_name text);
  create table if not exists plataforma1_espelho.user_on_classroom (user_id int, classroom_id int, status boolean);
  truncate plataforma1_espelho.user_on_classroom, plataforma1_espelho.user_, plataforma1_espelho.classroom restart identity;
`)
const salas = new Map()
for (const l of lanc) for (const prod of ['40D', '60D', '90D']) {
  const r = await c.query('insert into plataforma1_espelho.classroom (oab, classroom_type_name) values ($1,$2) returning id', [l.oab, prod])
  salas.set(`${l.oab}|${prod}`, r.rows[0].id)
}
let total = 0
for (const l of lanc) for (const a of l.alunos) {
  const u = await c.query("insert into plataforma1_espelho.user_ (role, email, cellphone) values ('STUDENT',$1,$2) returning id", [a.email, a.tel])
  await c.query('insert into plataforma1_espelho.user_on_classroom values ($1,$2,true)', [u.rows[0].id, salas.get(`${a.oab}|${a.produto}`)])
  total++
}
await c.end()
console.log(`OK: ${total} alunos de teste; CSVs em dados/ (${lanc.map((l) => `OAB ${l.oab}: ${l.leads.length} leads / ${l.alunos.length} compras`).join(' · ')})`)
