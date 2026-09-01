#!/usr/bin/env node
/**
 * Runner de migrations — aplica db/migrations/*.sql em ordem, uma vez cada.
 *
 * Substitui o `supabase db push`: não precisa de psql instalado nem de CLI
 * externo, só do Node que já roda o projeto.
 *
 *   npm run db:migrate
 *   npm run db:migrate:dry     (mostra o que aplicaria, sem escrever)
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { RAIZ, configDoBanco, descrever } from '../scripts/env.mjs'

const DRY = process.argv.includes('--dry-run')
const PASTA = path.join(RAIZ, 'db', 'migrations')

const cfg = configDoBanco()
const c = new pg.Client({ ...cfg, connectionTimeoutMillis: 20000 })

const arquivos = fs
  .readdirSync(PASTA)
  .filter((f) => f.endsWith('.sql'))
  .sort()

console.log(`\nBanco: ${descrever(cfg)}`)
console.log(`${arquivos.length} migration(s) em db/migrations\n`)

await c.connect()

try {
  await c.query('create schema if not exists leadscore')
  await c.query(`
    create table if not exists leadscore.migrations (
      nome        text primary key,
      hash        text not null,
      aplicada_em timestamptz not null default now()
    )
  `)

  const aplicadas = new Map(
    (await c.query('select nome, hash from leadscore.migrations')).rows.map((r) => [r.nome, r.hash]),
  )

  let novas = 0
  for (const nome of arquivos) {
    const sql = fs.readFileSync(path.join(PASTA, nome), 'utf8')
    const hash = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16)

    if (aplicadas.has(nome)) {
      if (aplicadas.get(nome) !== hash) {
        console.log(`  ~ ${nome} — já aplicada, mas o arquivo MUDOU desde então.`)
        console.log('    Migrations são imutáveis: crie um arquivo novo com a alteração.')
      } else {
        console.log(`  · ${nome} — já aplicada`)
      }
      continue
    }

    if (DRY) {
      console.log(`  + ${nome} — seria aplicada (${sql.split('\n').length} linhas)`)
      novas++
      continue
    }

    process.stdout.write(`  + ${nome} … `)
    await c.query('begin')
    try {
      await c.query(sql)
      await c.query('insert into leadscore.migrations (nome, hash) values ($1,$2)', [nome, hash])
      await c.query('commit')
      console.log('ok')
      novas++
    } catch (e) {
      await c.query('rollback')
      console.log('FALHOU')
      console.error(`\n    ${e.message}\n`)
      if (e.position) {
        const antes = sql.slice(0, Number(e.position))
        console.error(`    linha ${antes.split('\n').length} do arquivo\n`)
      }
      process.exit(1)
    }
  }

  console.log(
    novas === 0
      ? '\nNada a fazer — o banco já está atualizado.\n'
      : DRY
        ? `\n${novas} migration(s) pendente(s). Rode sem --dry-run pra aplicar.\n`
        : `\n${novas} migration(s) aplicada(s).\n`,
  )
} finally {
  await c.end().catch(() => {})
}
