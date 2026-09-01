/**
 * Cliente mínimo do Supabase para o Worker.
 *
 * Fala direto com PostgREST e com o Storage via fetch — sem SDK, porque o
 * Worker só precisa de um punhado de operações e o bundle fica minúsculo.
 * Usa a service_role: as tabelas estão com RLS ligado e sem policies, então
 * ninguém além daqui enxerga os dados.
 */

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  /** Se definido, toda chamada /api exige o header x-painel-token. */
  PAINEL_TOKEN?: string
  /** Bucket dos CSVs brutos. Padrão: leadscore-csv */
  STORAGE_BUCKET?: string
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

export class ErroSupabase extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export class Supa {
  readonly bucket: string

  constructor(private env: Env) {
    this.bucket = env.STORAGE_BUCKET || 'leadscore-csv'
  }

  private get base() {
    return this.env.SUPABASE_URL.replace(/\/+$/, '')
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...extra,
    }
  }

  private async rest(caminho: string, init: RequestInit = {}): Promise<Response> {
    const resp = await fetch(`${this.base}/rest/v1/${caminho}`, init)
    if (!resp.ok) {
      const corpo = await resp.text()
      throw new ErroSupabase(resp.status, `Supabase ${resp.status}: ${corpo.slice(0, 400)}`)
    }
    return resp
  }

  /** SELECT. `query` é a querystring do PostgREST (select=…&order=…). */
  async select<T = any>(tabela: string, query: string): Promise<T[]> {
    const resp = await this.rest(`${tabela}?${query}`, { headers: this.headers() })
    return resp.json()
  }

  /** SELECT com contagem exata — devolve as linhas e o total sem paginação. */
  async selectComTotal<T = any>(tabela: string, query: string): Promise<{ linhas: T[]; total: number }> {
    const resp = await this.rest(`${tabela}?${query}`, {
      headers: this.headers({ Prefer: 'count=exact' }),
    })
    const range = resp.headers.get('content-range') || ''
    const total = Number(range.split('/')[1]) || 0
    return { linhas: await resp.json(), total }
  }

  async insert<T = any>(tabela: string, linhas: unknown, opcoes: { retornar?: boolean; onConflict?: string } = {}): Promise<T[]> {
    const prefer = [
      opcoes.retornar ? 'return=representation' : 'return=minimal',
      opcoes.onConflict ? 'resolution=merge-duplicates' : '',
    ]
      .filter(Boolean)
      .join(',')
    const qs = opcoes.onConflict ? `?on_conflict=${encodeURIComponent(opcoes.onConflict)}` : ''
    const resp = await this.rest(`${tabela}${qs}`, {
      method: 'POST',
      headers: this.headers({ Prefer: prefer }),
      body: JSON.stringify(linhas),
    })
    return opcoes.retornar ? resp.json() : []
  }

  async patch<T = any>(tabela: string, query: string, corpo: unknown): Promise<T[]> {
    const resp = await this.rest(`${tabela}?${query}`, {
      method: 'PATCH',
      headers: this.headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(corpo),
    })
    return resp.json()
  }

  async remover(tabela: string, query: string): Promise<void> {
    await this.rest(`${tabela}?${query}`, { method: 'DELETE', headers: this.headers() })
  }

  /** Chama uma função SQL (ls_*). */
  async rpc<T = any>(funcao: string, args: Record<string, unknown> = {}): Promise<T> {
    const resp = await this.rest(`rpc/${funcao}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(args),
    })
    const texto = await resp.text()
    return texto ? JSON.parse(texto) : (null as T)
  }

  // ------------------------------------------------------------- Storage ---

  /** URL assinada para o navegador subir o CSV direto pro Storage. */
  async urlDeUpload(caminho: string): Promise<{ url: string; caminho: string }> {
    const resp = await fetch(
      `${this.base}/storage/v1/object/upload/sign/${this.bucket}/${caminho}`,
      { method: 'POST', headers: this.headers(), body: '{}' },
    )
    if (!resp.ok) {
      throw new ErroSupabase(resp.status, `Storage ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
    }
    const { url } = (await resp.json()) as { url: string }
    return { url: `${this.base}/storage/v1${url}`, caminho }
  }

  async apagarArquivo(caminho: string): Promise<void> {
    await fetch(`${this.base}/storage/v1/object/${this.bucket}/${caminho}`, {
      method: 'DELETE',
      headers: this.headers(),
    }).catch(() => {})
  }

  /** Garante que o bucket existe (privado). Idempotente. */
  async garantirBucket(): Promise<void> {
    const resp = await fetch(`${this.base}/storage/v1/bucket`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false }),
    })
    if (!resp.ok && resp.status !== 409) {
      const corpo = await resp.text()
      // "already exists" também volta como 400 em algumas versões
      if (!/exist/i.test(corpo)) throw new ErroSupabase(resp.status, `Bucket: ${corpo.slice(0, 300)}`)
    }
  }
}
