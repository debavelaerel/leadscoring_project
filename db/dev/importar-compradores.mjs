// Carrega compradores reais (export de vendas da Hotmart, CSV com ";") no espelho LOCAL
// (plataforma1_espelho), no formato que ls_compradores / ls_match_* leem.
// Aceita os dois formatos de export: o antigo (Status / Email / DDD + Telefone) e o novo
// (Status da transação / Email do(a) Comprador(a) / Telefone já com DDD).
//
// Uso:
//   DATABASE_URL=postgres://localhost:5432/leadscore_local \
//     node db/dev/importar-compradores.mjs --limpar \
//       47=~/Downloads/120d-oab47.1.csv 48=~/Downloads/120d-oab48.csv [--curso 120D]
//
// --limpar        apaga TUDO do espelho antes (inclusive os alunos fake do seed).
// --substituir    apaga só a turma (OAB + curso) que está sendo carregada e recarrega.
//
// Janela de compra (evita contar como "comprou" venda de OUTRO lançamento):
// --janela-leads  só vale compra entre o 1º e o 99º percentil dos cadastros da lista de leads
//                 da mesma OAB/curso (já importada no banco) + --dias (padrão 45) depois do último.
// --desde AAAA-MM-DD / --ate AAAA-MM-DD   janela manual (vence a automática no lado informado).
// Recusa rodar fora de localhost, como o semear-local.mjs.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import pg from 'pg'
import Papa from 'papaparse'

const url = process.env.DATABASE_URL || ''
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('Recusado: DATABASE_URL precisa apontar para localhost (este script grava no espelho).')
  process.exit(1)
}

const args = process.argv.slice(2)
const limpar = args.includes('--limpar')
const substituir = args.includes('--substituir')
const janelaLeads = args.includes('--janela-leads')
const opcao = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const dias = Number(opcao('dias') ?? 45)
const ci = args.indexOf('--curso')
const curso = ci >= 0 ? args[ci + 1] : '120D'
const pares = args.filter((a) => /^\d+=/.test(a)).map((a) => {
  const [oab, ...resto] = a.split('=')
  return { oab: Number(oab), arquivo: resto.join('=').replace(/^~/, homedir()) }
})
if (!pares.length) {
  console.error('Uso: importar-compradores.mjs [--limpar] 47=arquivo.csv 48=arquivo.csv [--curso 120D]')
  process.exit(1)
}

// data da venda: "dd/mm/aaaa hh:mm:ss" (formato novo e antigo)
function dataVenda(l) {
  const t = (l['Data da transação'] || l['Data de Venda'] || '').trim()
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`) : null
}
const dia = (d) => d.toISOString().slice(0, 10)

// só vendas efetivadas
const STATUS_OK = new Set(['completo', 'aprovado'])

const c = new pg.Client({ connectionString: url })
await c.connect()
await c.query(`
  create schema if not exists plataforma1_espelho;
  create table if not exists plataforma1_espelho.user_ (id serial primary key, role text, email text, cellphone text);
  create table if not exists plataforma1_espelho.classroom (id serial primary key, oab int, classroom_type_name text);
  create table if not exists plataforma1_espelho.user_on_classroom (user_id int, classroom_id int, status boolean);
`)
if (limpar) {
  await c.query('truncate plataforma1_espelho.user_on_classroom, plataforma1_espelho.user_, plataforma1_espelho.classroom restart identity')
  console.log('Espelho limpo (dados fake removidos).')
}

for (const { oab, arquivo } of pares) {
  if (substituir) {
    const { rows: salas } = await c.query('select id from plataforma1_espelho.classroom where oab = $1 and classroom_type_name = $2', [oab, curso])
    for (const { id } of salas) {
      await c.query('delete from plataforma1_espelho.user_ where id in (select user_id from plataforma1_espelho.user_on_classroom where classroom_id = $1)', [id])
      await c.query('delete from plataforma1_espelho.user_on_classroom where classroom_id = $1', [id])
      await c.query('delete from plataforma1_espelho.classroom where id = $1', [id])
    }
    if (salas.length) console.log(`OAB ${oab} — ${curso}: turma anterior removida antes de recarregar.`)
  }

  // janela de compra
  let inicio = opcao('desde') ? new Date(`${opcao('desde')}T00:00:00Z`) : null
  let fim = opcao('ate') ? new Date(`${opcao('ate')}T00:00:00Z`) : null
  if (janelaLeads) {
    const { rows } = await c.query(
      `select d.nome, d.id from leadscore.datasets d where d.oab = $1 and d.curso = $2 order by d.criado_em desc limit 1`, [oab, curso])
    if (!rows.length) throw new Error(`--janela-leads: não há lista de leads importada para OAB ${oab} ${curso}`)
    const { rows: [j] } = await c.query(
      `select percentile_disc(0.01) within group (order by d) as ini, percentile_disc(0.99) within group (order by d) as fim
         from (select substring(data_lead from '^[0-9]{4}-[0-9]{2}-[0-9]{2}')::date as d from leadscore.leads
                where dataset_id = $1 and data_lead ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}') x`, [rows[0].id])
    if (!j.ini) throw new Error('--janela-leads: a lista não tem datas de cadastro legíveis')
    inicio ??= new Date(`${dia(j.ini)}T00:00:00Z`)
    fim ??= new Date(new Date(`${dia(j.fim)}T00:00:00Z`).getTime() + dias * 86400000)
    console.log(`OAB ${oab} — ${curso}: lista "${rows[0].nome}" (cadastros ${dia(j.ini)} → ${dia(j.fim)}), janela de compra ${dia(inicio)} → ${dia(fim)}`)
  }
  const csv = Papa.parse(readFileSync(arquivo, 'utf8').replace(/^﻿/, ''), { header: true, delimiter: ';', skipEmptyLines: true })
  // um comprador por e-mail (a mesma pessoa aparece em várias linhas/parcelas)
  const unicos = new Map()
  let ignorados = 0
  let foraDaJanela = 0
  const campos = csv.meta.fields
  const colStatus = ['Status da transação', 'Status'].find((c) => campos.includes(c))
  const colEmail = ['Email do(a) Comprador(a)', 'Email'].find((c) => campos.includes(c))
  if (!colStatus || !colEmail) throw new Error(`${arquivo}: não achei as colunas de status e e-mail`)
  const temDDD = campos.includes('DDD')
  for (const l of csv.data) {
    if (!STATUS_OK.has((l[colStatus] || '').trim().toLowerCase())) { ignorados++; continue }
    if (inicio || fim) {
      const d = dataVenda(l)
      if (!d || (inicio && d < inicio) || (fim && d > fim)) { foraDaJanela++; continue }
    }
    const email = (l[colEmail] || '').trim().toLowerCase()
    if (!email) { ignorados++; continue }
    if (!unicos.has(email)) {
      let tel = `${temDDD ? (l['DDD'] || '').replace(/\D/g, '') : ''}${(l['Telefone'] || '').replace(/\D/g, '')}`
      if (!temDDD && tel.length > 11 && tel.startsWith('55')) tel = tel.slice(2) // +55 do formato novo
      unicos.set(email, tel)
    }
  }

  const { rows } = await c.query(
    'insert into plataforma1_espelho.classroom (oab, classroom_type_name) values ($1,$2) returning id',
    [oab, curso],
  )
  const sala = rows[0].id
  for (const [email, tel] of unicos) {
    const u = await c.query(
      "insert into plataforma1_espelho.user_ (role, email, cellphone) values ('STUDENT',$1,$2) returning id",
      [email, tel],
    )
    await c.query('insert into plataforma1_espelho.user_on_classroom values ($1,$2,true)', [u.rows[0].id, sala])
  }
  console.log(`OAB ${oab} — ${curso}: ${unicos.size} compradores únicos (${csv.data.length} linhas, ${ignorados} ignoradas${inicio || fim ? `, ${foraDaJanela} fora da janela de compra` : ''})`)
}
await c.end()
