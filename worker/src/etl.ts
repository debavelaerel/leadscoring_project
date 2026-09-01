/**
 * ETL — limpeza e padronização de e-mail/telefone.
 *
 * Porte fiel de api/etl.py. As regras de telefone são as mesmas do painel de
 * aprovados: remove não-dígitos, descarta o código do país 55 e separa em
 * (ddd, numero). O 9º dígito entra como variante para o match não perder gente.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function limparEmail(bruto: unknown): string | null {
  if (bruto === null || bruto === undefined) return null
  const email = String(bruto).trim().toLowerCase()
  if (!email) return null
  return EMAIL_RE.test(email) ? email : null
}

export function limparTelefone(bruto: unknown): [string | null, string | null] {
  if (bruto === null || bruto === undefined) return [null, null]
  let digitos = String(bruto).replace(/\D/g, '')
  if (digitos.length >= 12 && digitos.startsWith('55')) digitos = digitos.slice(2)
  if (digitos.length < 3) return [null, digitos || null]
  return [digitos.slice(0, 2), digitos.slice(2)]
}

export function chavesTelefone(ddd: string | null, numero: string | null): string[] {
  if (!ddd || !numero || numero.length < 8) return []
  const chaves = [ddd + numero]
  if (numero.length === 9 && numero.startsWith('9')) {
    chaves.push(ddd + numero.slice(1)) // variante sem o 9º dígito
  } else if (numero.length === 8) {
    chaves.push(ddd + '9' + numero) // variante com o 9º dígito
  }
  return chaves
}

export interface Mapeamento {
  email: string | null
  telefone?: string | null
  nome?: string | null
  data?: string | null
  perguntas: string[]
}

export interface LeadRow {
  dataset_id: string
  linha: number
  nome: string
  email: string | null
  telefone_fmt: string
  tel_chaves: string[]
  data_lead: string
  respostas: Record<string, string | null>
  respondeu: boolean
}

const texto = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())

/** Uma linha crua do CSV vira um lead normalizado, pronto pro banco. */
export function prepararLead(
  linha: Record<string, unknown>,
  mapa: Mapeamento,
  datasetId: string,
  indice: number,
): LeadRow {
  const email = mapa.email ? limparEmail(linha[mapa.email]) : null
  const [ddd, numero] = mapa.telefone ? limparTelefone(linha[mapa.telefone]) : [null, null]

  const respostas: Record<string, string | null> = {}
  let respondeu = false
  for (const p of mapa.perguntas) {
    const v = texto(linha[p])
    respostas[p] = v || null
    if (v) respondeu = true
  }

  return {
    dataset_id: datasetId,
    linha: indice,
    nome: mapa.nome ? texto(linha[mapa.nome]) : '',
    email,
    telefone_fmt: ddd && numero ? `(${ddd}) ${numero}` : numero || '',
    tel_chaves: chavesTelefone(ddd, numero),
    data_lead: mapa.data ? texto(linha[mapa.data]) : '',
    respostas,
    respondeu,
  }
}
