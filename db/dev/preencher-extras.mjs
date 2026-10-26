// Preenche leads.extras (UTMs de campanha/criativo/público) de bases já importadas,
// casando o CSV original com o banco LOCAL por e-mail.
//   DATABASE_URL=postgres://localhost:5432/leadscore_local \
//     node db/dev/preencher-extras.mjs "OAB 47 — 120D=~/Downloads/Leads 120D - OAB 47 - Leads.csv" ...
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import pg from 'pg'
import Papa from 'papaparse'

const url = process.env.DATABASE_URL || ''
if (!/localhost|127\.0\.0\.1/.test(url)) { console.error('Recusado: só roda em localhost.'); process.exit(1) }
const COLS = ['utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
const c = new pg.Client({ connectionString: url }); await c.connect()

for (const par of process.argv.slice(2)) {
  const [nome, ...resto] = par.split('=')
  const csv = Papa.parse(readFileSync(resto.join('=').replace(/^~/, homedir()), 'utf8').replace(/^﻿/, ''), { header: true, skipEmptyLines: true })
  const campos = csv.meta.fields
  const colEmail = campos.find((f) => /^e-?mail$/i.test(f.trim()))
  const perguntas = campos.filter((f) => !/^(e-?mail|telefone|nome|created_at|xcode)$/i.test(f.trim()) && !/^utm/i.test(f) && !/perfeito/i.test(f))
  const melhor = new Map() // mesma regra do upload: fica o cadastro mais respondido, empate = o primeiro
  for (const l of csv.data) {
    const e = (l[colEmail] || '').trim().toLowerCase(); if (!e) continue
    const k = perguntas.filter((p) => (l[p] || '').trim()).length
    if (!melhor.has(e) || k > melhor.get(e).k) melhor.set(e, { l, k })
  }
  const { rows } = await c.query('select id from leadscore.datasets where nome = $1', [nome])
  if (rows.length !== 1) { console.error(`Base "${nome}": ${rows.length} encontradas, pulando`); continue }
  const ds = rows[0].id
  const cols = campos.filter((f) => COLS.includes(f.trim().toLowerCase()))
  let n = 0
  for (const [e, { l }] of melhor) {
    const extras = {}
    for (const col of cols) { const v = (l[col] || '').trim().toLowerCase(); if (v) extras[col.trim().toLowerCase()] = v }
    const r = await c.query('update leadscore.leads set extras = $3 where dataset_id = $1 and email = $2', [ds, e, JSON.stringify(extras)])
    n += r.rowCount
  }
  console.log(`${nome}: ${n} leads atualizados (${cols.join(', ')})`)
}
await c.end()
