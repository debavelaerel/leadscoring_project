/** Leitura do .env e montagem da conexão — compartilhado pelos scripts. */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function carregarEnv() {
  // ordem de prioridade: o primeiro que definir a variável ganha.
  // api/.env entra por último só pra reaproveitar as credenciais que já estavam lá.
  for (const arquivo of [
    path.join(RAIZ, '.env'),
    path.join(RAIZ, '.dev.vars'),
    path.join(RAIZ, 'api', '.env'),
  ]) {
    if (!fs.existsSync(arquivo)) continue
    for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
      if (linha.trim().startsWith('#')) continue
      const m = linha.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const valor = m[2].replace(/^["']|["']$/g, '')
      if (!(m[1] in process.env)) process.env[m[1]] = valor
    }
  }
}

/** Aceita DATABASE_URL ou o conjunto DB_HOST/DB_USER/... */
export function configDoBanco() {
  carregarEnv()
  const url = process.env.DATABASE_URL
  if (url) {
    const comTls = /sslmode=(require|prefer|verify-ca|verify-full|no-verify)/.test(url)
    return { connectionString: url, ssl: comTls ? { rejectUnauthorized: false } : false }
  }
  if (!process.env.DB_HOST) {
    console.error('Faltou DATABASE_URL no .env (ou DB_HOST/DB_USER/DB_PASSWORD).')
    process.exit(1)
  }
  const sslmode = process.env.DB_SSLMODE || 'disable'
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: sslmode === 'disable' ? false : { rejectUnauthorized: false },
  }
}

export const descrever = (cfg) => {
  if (cfg.connectionString) {
    return cfg.connectionString.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')
  }
  return `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`
}
