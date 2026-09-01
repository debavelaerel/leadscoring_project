/**
 * Conexão com o Postgres do RDS a partir do Worker.
 *
 * O Worker abre um socket TCP direto (cloudflare:sockets, via node-postgres com
 * `nodejs_compat`). Se existir um binding de Hyperdrive, ele é usado no lugar —
 * aí vem pooling e cache de query de brinde, sem mudar uma linha das rotas.
 *
 * Uma conexão por requisição, sempre fechada no fim: Worker não guarda estado
 * entre requisições e conexão vazada vira slot preso no banco.
 */

import { Client } from 'pg'

export interface Env {
  /** postgres://usuario:senha@host:5432/postgres?sslmode=require */
  DATABASE_URL: string
  /** Binding opcional de Hyperdrive (tem prioridade sobre DATABASE_URL). */
  HYPERDRIVE?: { connectionString: string }
  /** Se definido, toda chamada /api exige o header x-painel-token. */
  PAINEL_TOKEN?: string
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

export function stringDeConexao(env: Env): string {
  const url = env.HYPERDRIVE?.connectionString || env.DATABASE_URL
  if (!url) throw new Error('Falta DATABASE_URL (ou o binding HYPERDRIVE).')
  return url
}

function cliente(env: Env): Client {
  const url = stringDeConexao(env)
  // sslmode=disable é o padrão do banco hoje; se o RDS aceitar TLS, troque para
  // sslmode=require na DATABASE_URL — a senha deixa de trafegar em claro.
  const comTls = /sslmode=(require|prefer|verify-ca|verify-full|no-verify)/.test(url)
  return new Client({
    connectionString: url,
    ssl: comTls ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
    query_timeout: 60000,
    statement_timeout: 60000,
    application_name: 'leadscore-worker',
  })
}

/** Abre a conexão, roda o que você mandar e fecha — mesmo se der erro. */
export async function comBanco<T>(env: Env, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = cliente(env)
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}

/**
 * Versão para respostas em streaming (o export de CSV): a conexão precisa
 * sobreviver ao retorno do handler, então quem chama fecha no fim do stream.
 */
export async function abrirConexao(env: Env): Promise<Client> {
  const c = cliente(env)
  await c.connect()
  return c
}

/** Monta os placeholders de um INSERT com várias linhas. */
export function tuplas(linhas: unknown[][]): { texto: string; valores: unknown[] } {
  const valores: unknown[] = []
  const partes = linhas.map((linha) => {
    const inicio = valores.length
    valores.push(...linha)
    return `(${linha.map((_, i) => `$${inicio + i + 1}`).join(',')})`
  })
  return { texto: partes.join(','), valores }
}
