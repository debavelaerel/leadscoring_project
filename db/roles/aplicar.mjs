/**
 * Aplica db/roles/leadscore_app.sql, trocando o placeholder de senha pelo
 * valor de LEADSCORE_APP_SENHA.
 *
 * A senha vem do ambiente de propósito: assim ela não entra no repositório,
 * nem no histórico do shell (se você usar o prefixo abaixo), nem em log nenhum.
 *
 *   LEADSCORE_APP_SENHA="$(openssl rand -base64 24)" node db/roles/aplicar.mjs
 *
 * Conecta com a credencial administrativa de sempre (.env → .dev.vars →
 * api/.env), porque criar papel exige poder de criar papel.
 */

import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { configDoBanco, descrever, RAIZ } from '../../scripts/env.mjs'

const senha = process.env.LEADSCORE_APP_SENHA
if (!senha) {
  console.error('Faltou LEADSCORE_APP_SENHA.\n')
  console.error('  LEADSCORE_APP_SENHA="$(openssl rand -base64 24)" node db/roles/aplicar.mjs\n')
  process.exit(1)
}
if (senha.length < 16) {
  console.error(`Senha curta demais (${senha.length} caracteres). Use pelo menos 16.`)
  process.exit(1)
}

const arquivo = path.join(RAIZ, 'db', 'roles', 'leadscore_app.sql')
const sql = fs.readFileSync(arquivo, 'utf8')

if (!sql.includes('TROQUE_ESTA_SENHA')) {
  console.error('O placeholder TROQUE_ESTA_SENHA não está no .sql — nada a fazer.')
  process.exit(1)
}

// escapa aspas simples: o SQL põe a senha entre aspas
const comSenha = sql.replaceAll('TROQUE_ESTA_SENHA', senha.replaceAll("'", "''"))

const cfg = configDoBanco()
console.log(`\nBanco: ${descrever(cfg)}`)

const c = new pg.Client(cfg)
await c.connect()

try {
  const { rowCount } = await c.query("select 1 from pg_roles where rolname = 'leadscore_app'")
  if (rowCount) {
    console.log('\nleadscore_app já existe. Para só trocar a senha:')
    console.log("  alter role leadscore_app with password '<nova>';\n")
    process.exit(1)
  }

  // o .sql já traz begin/commit
  await c.query(comSenha)

  const { rows } = await c.query(`
    select r.rolsuper, r.rolcreaterole, r.rolcreatedb,
           pg_get_userbyid(n.nspowner) as dono_leadscore
      from pg_roles r, pg_namespace n
     where r.rolname = 'leadscore_app' and n.nspname = 'leadscore'`)

  console.log('\n\x1b[32mPapel criado.\x1b[0m')
  console.log(`  superusuário: ${rows[0].rolsuper}`)
  console.log(`  cria papel:   ${rows[0].rolcreaterole}`)
  console.log(`  cria banco:   ${rows[0].rolcreatedb}`)
  console.log(`  dono do schema leadscore: ${rows[0].dono_leadscore}`)
  console.log('\nAgora aponte o Worker para ele:')
  console.log('  npx wrangler secret put DATABASE_URL')
  console.log('  postgres://leadscore_app:<senha>@56.126.74.248:5432/postgres?sslmode=disable\n')
} catch (e) {
  console.error(`\n\x1b[31mFalhou:\x1b[0m ${e.message}`)
  console.error('Nada foi aplicado — o script roda numa transação só.\n')
  process.exitCode = 1
} finally {
  await c.end().catch(() => {})
}
