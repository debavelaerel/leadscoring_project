#!/usr/bin/env node
/**
 * Diagnóstico do banco antes de aplicar as migrations.
 *
 * Responde, em ordem: eu conecto? é réplica (só leitura)? consigo ler o
 * espelho? consigo criar o schema leadscore? o gen_random_uuid() existe?
 * o banco aceita TLS?
 *
 *   npm run db:check
 */

import pg from 'pg'
import { configDoBanco, descrever } from './env.mjs'

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
const nao = (msg) => console.log(`  \x1b[31m✗\x1b[0m ${msg}`)
const aviso = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`)

const cfg = configDoBanco()
let problemas = 0

async function conectar(config) {
  const c = new pg.Client({ ...config, connectionTimeoutMillis: 20000 })
  await c.connect()
  return c
}

console.log(`\nBanco: ${descrever(cfg)}\n`)

let c
try {
  c = await conectar(cfg)
  ok('conexão estabelecida')
} catch (e) {
  nao(`não conectei: ${e.message}`)
  console.log('\n  Verifique host/porta/usuário/senha e se o security group libera a sua saída.\n')
  process.exit(1)
}

try {
  const { rows } = await c.query('select current_user, current_database(), version()')
  ok(`usuário ${rows[0].current_user} no banco ${rows[0].current_database}`)
  console.log(`    ${rows[0].version.split(',')[0]}`)

  // --- réplica? ------------------------------------------------------------
  const { rows: r } = await c.query('select pg_is_in_recovery() as replica')
  if (r[0].replica) {
    nao('esta instância é RÉPLICA (somente leitura) — não dá para criar tabelas aqui')
    problemas++
  } else {
    ok('instância primária (aceita escrita)')
  }

  // --- espelho legível? ----------------------------------------------------
  try {
    const { rows: e } = await c.query(`
      select count(*)::int as n
        from plataforma1_espelho.user_on_classroom uoc
        join plataforma1_espelho.classroom c on c.id = uoc.classroom_id
        join plataforma1_espelho.user_ u on u.id = uoc.user_id
       where u.role = 'STUDENT' and uoc.status is true and c.oab is not null
    `)
    ok(`plataforma1_espelho legível — ${e[0].n.toLocaleString('pt-BR')} matrículas ativas com OAB`)
    const { rows: t } = await c.query(`
      select c.oab, c.classroom_type_name as curso, count(*)::int as alunos
        from plataforma1_espelho.user_on_classroom uoc
        join plataforma1_espelho.classroom c on c.id = uoc.classroom_id
        join plataforma1_espelho.user_ u on u.id = uoc.user_id
       where u.role = 'STUDENT' and uoc.status is true and c.oab is not null
       group by 1,2 order by c.oab desc limit 6
    `)
    for (const x of t) console.log(`    OAB ${x.oab} — ${x.curso}: ${x.alunos.toLocaleString('pt-BR')} alunos`)
  } catch (e) {
    nao(`não consigo ler plataforma1_espelho: ${e.message}`)
    problemas++
  }

  // --- gen_random_uuid ------------------------------------------------------
  try {
    await c.query('select gen_random_uuid()')
    ok('gen_random_uuid() disponível')
  } catch {
    aviso('gen_random_uuid() ausente — a migration tenta criar a extensão pgcrypto')
  }

  // --- permissão de criar schema -------------------------------------------
  const jaExiste = (await c.query("select 1 from information_schema.schemata where schema_name = 'leadscore'")).rowCount
  if (jaExiste) {
    ok('schema leadscore já existe')
    try {
      await c.query('create table if not exists leadscore._teste_permissao (x int)')
      await c.query('drop table if exists leadscore._teste_permissao')
      ok('consigo criar tabelas dentro de leadscore')
    } catch (e) {
      nao(`sem permissão de escrita em leadscore: ${e.message}`)
      problemas++
    }
  } else {
    try {
      await c.query('create schema leadscore_teste_permissao')
      await c.query('drop schema leadscore_teste_permissao')
      ok('consigo criar schema (a migration vai criar o leadscore)')
    } catch (e) {
      nao(`sem permissão de criar schema: ${e.message}`)
      console.log('    Peça pra infra: CREATE SCHEMA leadscore AUTHORIZATION <seu_usuario>;')
      problemas++
    }
  }
} finally {
  await c.end().catch(() => {})
}

// --- TLS ---------------------------------------------------------------------
try {
  const base = cfg.connectionString
    ? { connectionString: cfg.connectionString.replace(/sslmode=\w+/, 'sslmode=require') }
    : { ...cfg }
  const t = await conectar({ ...base, ssl: { rejectUnauthorized: false } })
  const { rows } = await t.query('select ssl from pg_stat_ssl where pid = pg_backend_pid()')
  await t.end()
  if (rows[0]?.ssl) ok('o banco aceita TLS — use ?sslmode=require na DATABASE_URL do Worker')
  else aviso('conectou sem TLS mesmo pedindo — a senha vai trafegar em texto puro pela internet')
} catch (e) {
  aviso(`TLS não disponível (${e.message.split('\n')[0]})`)
  console.log('    O Worker vai conectar em texto puro. Vale pedir TLS pra infra antes de subir em produção.')
}

console.log(
  problemas === 0
    ? '\n\x1b[32mTudo certo.\x1b[0m Pode rodar: npm run db:migrate\n'
    : `\n\x1b[31m${problemas} bloqueio(s).\x1b[0m Resolva antes de rodar as migrations.\n`,
)
process.exit(problemas === 0 ? 0 : 1)
