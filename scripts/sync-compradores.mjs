#!/usr/bin/env node
/**
 * Sincroniza os compradores do RDS (plataforma1_espelho) para o Supabase.
 *
 * Compradores = alunos com role STUDENT e matrícula ativa (user_on_classroom
 * com status TRUE) na edição OAB / tipo de turma — o mesmo caminho usado pelo
 * painel de aprovados. É o único ponto do projeto que ainda toca o RDS: o
 * Worker lê só do Supabase.
 *
 * Uso:
 *   node scripts/sync-compradores.mjs --listar
 *   node scripts/sync-compradores.mjs --oab 47
 *   node scripts/sync-compradores.mjs --oab 47 --curso "90 dias"
 *   node scripts/sync-compradores.mjs --todas
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ------------------------------------------------------------------ .env ----
function carregarEnv(arquivo) {
  if (!fs.existsSync(arquivo)) return
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/)
    if (!m || linha.trim().startsWith('#')) continue
    const valor = m[2].replace(/^["']|["']$/g, '')
    if (!(m[1] in process.env)) process.env[m[1]] = valor
  }
}
carregarEnv(path.join(RAIZ, '.env'))
carregarEnv(path.join(RAIZ, 'api', '.env')) // compatibilidade com o .env antigo

// ------------------------------------------------------------- argumentos ---
const args = process.argv.slice(2)
const pegar = (nome) => {
  const i = args.indexOf(`--${nome}`)
  return i >= 0 ? args[i + 1] : null
}
const tem = (nome) => args.includes(`--${nome}`)

const OAB = pegar('oab') ? Number(pegar('oab')) : null
const CURSO = pegar('curso')
const LISTAR = tem('listar')
const TODAS = tem('todas')

// --------------------------------------------------------------- Supabase ---
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

function exigirSupabase() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Faltou SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env da raiz.')
    process.exit(1)
  }
}

async function supabase(caminho, init = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (!resp.ok) {
    throw new Error(`Supabase ${resp.status}: ${(await resp.text()).slice(0, 400)}`)
  }
  return resp
}

// -------------------------------------------------- normalização (etl.py) ---
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const limparEmail = (bruto) => {
  if (!bruto) return null
  const e = String(bruto).trim().toLowerCase()
  return EMAIL_RE.test(e) ? e : null
}

const limparTelefone = (bruto) => {
  if (!bruto) return [null, null]
  let d = String(bruto).replace(/\D/g, '')
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2)
  if (d.length < 3) return [null, d || null]
  return [d.slice(0, 2), d.slice(2)]
}

const chavesTelefone = (ddd, numero) => {
  if (!ddd || !numero || numero.length < 8) return []
  const chaves = [ddd + numero]
  if (numero.length === 9 && numero.startsWith('9')) chaves.push(ddd + numero.slice(1))
  else if (numero.length === 8) chaves.push(ddd + '9' + numero)
  return chaves
}

// -------------------------------------------------------------------- RDS ---
function clienteRds() {
  const host = process.env.DB_HOST
  if (!host) {
    console.error('Faltou DB_HOST no .env — sem isso não dá pra falar com o RDS.')
    process.exit(1)
  }
  return new pg.Client({
    host,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: (process.env.DB_SSLMODE || 'disable') === 'disable' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  })
}

const SQL_TURMAS = `
  SELECT c.oab, c.classroom_type_name AS curso, COUNT(*)::int AS alunos
    FROM plataforma1_espelho.user_on_classroom uoc
    JOIN plataforma1_espelho.classroom c ON c.id = uoc.classroom_id
    JOIN plataforma1_espelho.user_ u     ON u.id = uoc.user_id
   WHERE u.role = 'STUDENT' AND uoc.status IS TRUE AND c.oab IS NOT NULL
   GROUP BY c.oab, c.classroom_type_name
   ORDER BY c.oab DESC, curso
`

const SQL_COMPRADORES = `
  SELECT DISTINCT u.email AS email, u.cellphone AS telefone
    FROM plataforma1_espelho.user_on_classroom uoc
    JOIN plataforma1_espelho.classroom c ON c.id = uoc.classroom_id
    JOIN plataforma1_espelho.user_ u     ON u.id = uoc.user_id
   WHERE u.role = 'STUDENT'
     AND uoc.status IS TRUE
     AND c.oab = $1
     AND c.classroom_type_name = $2
`

async function sincronizarTurma(rds, oab, curso) {
  const { rows } = await rds.query(SQL_COMPRADORES, [oab, curso])

  const porChave = new Map()
  for (const r of rows) {
    const email = limparEmail(r.email)
    const [ddd, numero] = limparTelefone(r.telefone)
    const chaves = chavesTelefone(ddd, numero)
    if (!email && chaves.length === 0) continue
    const telefone = r.telefone ? String(r.telefone).trim() : null
    porChave.set(`${email || ''}|${telefone || ''}`, {
      oab,
      curso,
      email,
      telefone,
      tel_chaves: chaves,
    })
  }
  const compradores = [...porChave.values()]

  // refresh completo da turma: apaga e regrava
  await supabase(`compradores?oab=eq.${oab}&curso=eq.${encodeURIComponent(curso)}`, { method: 'DELETE' })

  const LOTE = 500
  for (let i = 0; i < compradores.length; i += LOTE) {
    await supabase('compradores', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(compradores.slice(i, i + LOTE)),
    })
  }

  const semContato = rows.length - compradores.length
  console.log(
    `  OAB ${oab} — ${curso}: ${compradores.length} compradores gravados` +
      (semContato > 0 ? ` (${semContato} sem e-mail/telefone utilizável)` : ''),
  )
  return compradores.length
}

// ------------------------------------------------------------------ main ----
async function main() {
  const rds = clienteRds()
  console.log(`Conectando no RDS (${process.env.DB_HOST})…`)
  await rds.connect()

  const { rows: turmas } = await rds.query(SQL_TURMAS)

  if (LISTAR) {
    console.log(`\n${turmas.length} turmas no espelho:\n`)
    for (const t of turmas) console.log(`  OAB ${t.oab} — ${t.curso} (${t.alunos} alunos)`)
    await rds.end()
    return
  }

  exigirSupabase()

  let alvo = turmas
  if (!TODAS) {
    if (!OAB) {
      console.error('Informe --oab 47 (e opcionalmente --curso "90 dias"), ou use --todas / --listar.')
      await rds.end()
      process.exit(1)
    }
    alvo = turmas.filter((t) => t.oab === OAB && (!CURSO || t.curso === CURSO))
    if (!alvo.length) {
      console.error(`Nenhuma turma encontrada para OAB ${OAB}${CURSO ? ` / ${CURSO}` : ''}.`)
      await rds.end()
      process.exit(1)
    }
  }

  console.log(`\nSincronizando ${alvo.length} turma(s):`)
  let total = 0
  for (const t of alvo) total += await sincronizarTurma(rds, t.oab, t.curso)

  await rds.end()
  console.log(`\nPronto: ${total} compradores no Supabase.`)
}

main().catch((e) => {
  console.error('\nFalhou:', e.message)
  process.exit(1)
})
