#!/usr/bin/env node
/**
 * Monta a DATABASE_URL a partir do que já existe (.env, .dev.vars ou o
 * api/.env antigo com DB_HOST/DB_USER/DB_PASSWORD) — assim a credencial fica
 * num lugar só e você nunca copia senha na mão.
 *
 *   npm run db:url                       imprime a URL (stdout limpo, dá pra usar em pipe)
 *   npm run db:dev-vars                  escreve/atualiza o .dev.vars pro `wrangler dev`
 *   npm run db:url | npx wrangler secret put DATABASE_URL     manda pro Cloudflare
 */

import fs from 'node:fs'
import path from 'node:path'
import { RAIZ, carregarEnv } from './env.mjs'

carregarEnv()

const DEV_VARS = process.argv.includes('--dev-vars')

function montarUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSLMODE } = process.env
  if (!DB_HOST || !DB_USER) {
    console.error(
      'Não achei nem DATABASE_URL nem DB_HOST/DB_USER.\n' +
        'Preencha o .env da raiz (veja .env.example) ou mantenha o api/.env antigo.',
    )
    process.exit(1)
  }
  const usuario = encodeURIComponent(DB_USER)
  const senha = encodeURIComponent(DB_PASSWORD || '')
  const sslmode = DB_SSLMODE || 'disable'
  return `postgres://${usuario}:${senha}@${DB_HOST}:${DB_PORT || 5432}/${DB_NAME || 'postgres'}?sslmode=${sslmode}`
}

const url = montarUrl()
const mascarada = url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')

if (!DEV_VARS) {
  // explicação vai pro stderr pra não sujar o pipe
  console.error(`\nDATABASE_URL montada: ${mascarada}\n`)
  process.stdout.write(url)
  process.exit(0)
}

const arquivo = path.join(RAIZ, '.dev.vars')
const atual = fs.existsSync(arquivo) ? fs.readFileSync(arquivo, 'utf8') : ''
const linha = `DATABASE_URL=${url}`
const novo = /^DATABASE_URL=.*$/m.test(atual)
  ? atual.replace(/^DATABASE_URL=.*$/m, linha)
  : `${atual}${atual && !atual.endsWith('\n') ? '\n' : ''}${linha}\n`

fs.writeFileSync(arquivo, novo)
console.log(`\n.dev.vars atualizado com ${mascarada}`)
console.log('O `wrangler dev` já vai usar essa conexão.\n')
