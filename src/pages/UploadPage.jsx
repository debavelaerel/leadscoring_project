import { useEffect, useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import { UploadCloud, FileSpreadsheet, Play, AlertTriangle, Database, Loader2, Info } from 'lucide-react'
import { getTurmas, enviarBase, criarAnalise } from '../lib/api.js'
import SeletorTurmas from '../components/SeletorTurmas.jsx'

/**
 * Nova análise:
 *  1) upload do CSV da pesquisa de leads
 *  2) o painel lê as colunas e sugere o papel de cada uma — o usuário confirma
 *     qual é a coluna de e-mail (obrigatória), telefone e quais são perguntas
 *  3) escolhe a turma (edição OAB × produto) cujos compradores estão no banco
 *  4) a base sobe pro Supabase (arquivo + leads normalizados) e a análise roda
 */

const PAPEIS = [
  { id: 'ignorar',  label: 'Ignorar' },
  { id: 'email',    label: 'E-mail' },
  { id: 'telefone', label: 'Telefone' },
  { id: 'nome',     label: 'Nome' },
  { id: 'data',     label: 'Data de cadastro' },
  { id: 'pergunta', label: 'Pergunta da pesquisa' },
]

function sugerirPapel(coluna, valores) {
  const c = coluna.toLowerCase()
  if (c.includes('mail')) return 'email'
  if (c.includes('telefone') || c.includes('phone') || c.includes('celular') || c === 'tel') return 'telefone'
  if (c === 'nome' || c === 'name' || c.includes('nome completo')) return 'nome'
  if (c.includes('created') || c.includes('data de') || c === 'data' || c === 'date') return 'data'
  if (c.startsWith('utm') || c === 'xcode' || c.includes('gclid') || c.includes('fbclid')) return 'ignorar'
  // heurística: pouca cardinalidade na amostra → pergunta fechada;
  // muitas respostas distintas → texto aberto (não entra no modelo de pesos)
  const distintos = new Set(valores.filter(Boolean))
  if (distintos.size > 25) return 'ignorar'
  if (distintos.size > 0) return 'pergunta'
  if (coluna.trim().endsWith('?')) return 'pergunta'
  return 'ignorar'
}

const ETAPAS = {
  preparando: 'Preparando o arquivo…',
  arquivo: 'Guardando o CSV original…',
  linhas: 'Enviando os leads pro banco…',
  concluido: 'Cruzando com os compradores…',
}

export default function UploadPage({ onConcluir, irParaBases }) {
  const inputRef = useRef(null)
  const [arquivo, setArquivo] = useState(null)
  const [colunas, setColunas] = useState([])       // [{nome, amostra:[], papel}]
  const [linhasAmostra, setLinhasAmostra] = useState(0)
  const [turmas, setTurmas] = useState([])
  const [turmasSel, setTurmasSel] = useState([])
  const [oabManual, setOabManual] = useState('')
  const [cursoManual, setCursoManual] = useState('')
  const [erroTurmas, setErroTurmas] = useState(null)
  const [processando, setProcessando] = useState(false)
  const [progresso, setProgresso] = useState(null)
  const [erro, setErro] = useState(null)
  const [duplicado, setDuplicado] = useState(null)
  const [arrastando, setArrastando] = useState(false)

  useEffect(() => {
    getTurmas()
      .then((r) => setTurmas(r.turmas || []))
      .catch((e) => setErroTurmas(e.message))
  }, [])

  const lerArquivo = (file) => {
    if (!file) return
    setErro(null)
    setDuplicado(null)
    setArquivo(file)
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      preview: 300, // amostra para detecção — o arquivo inteiro vai pro banco
      complete: ({ data, meta }) => {
        const nomes = meta.fields || []
        setLinhasAmostra(data.length)
        setColunas(nomes.map((nome) => {
          const valores = data.map((r) => (r[nome] || '').trim())
          return {
            nome,
            amostra: [...new Set(valores.filter(Boolean))].slice(0, 3),
            papel: sugerirPapel(nome, valores),
          }
        }))
      },
      error: () => setErro('Não consegui ler o CSV. Confira o arquivo.'),
    })
  }

  const definirPapel = (nome, papel) => {
    setColunas((cols) => cols.map((c) => {
      if (c.nome === nome) return { ...c, papel }
      // e-mail/telefone/nome/data são papéis únicos — desmarca o anterior
      if (['email', 'telefone', 'nome', 'data'].includes(papel) && c.papel === papel) {
        return { ...c, papel: 'ignorar' }
      }
      return c
    }))
  }

  const mapeamento = useMemo(() => ({
    email: colunas.find((c) => c.papel === 'email')?.nome || null,
    telefone: colunas.find((c) => c.papel === 'telefone')?.nome || null,
    nome: colunas.find((c) => c.papel === 'nome')?.nome || null,
    data: colunas.find((c) => c.papel === 'data')?.nome || null,
    perguntas: colunas.filter((c) => c.papel === 'pergunta').map((c) => c.nome),
  }), [colunas])

  // uma captação vende vários produtos: comprou = entrou em qualquer turma marcada
  const turmasEscolhidas = useMemo(() => {
    if (turmasSel.length) {
      return turmasSel.map((k) => {
        const [oab, ...resto] = k.split('|')
        return { oab: Number(oab), curso: resto.join('|') }
      })
    }
    if (oabManual && cursoManual) return [{ oab: Number(oabManual), curso: cursoManual }]
    return []
  }, [turmasSel, oabManual, cursoManual])

  const pronto = arquivo && mapeamento.email && mapeamento.perguntas.length > 0 && turmasEscolhidas.length > 0

  const rodar = async () => {
    if (!pronto || processando) return
    setProcessando(true)
    setErro(null)
    setDuplicado(null)
    setProgresso({ etapa: 'preparando', pct: 0 })
    const principal = turmasEscolhidas[0]
    const nome = turmasEscolhidas.length === 1
      ? `OAB ${principal.oab} — ${principal.curso}`
      : `OAB ${principal.oab} — ${turmasEscolhidas.length} turmas`
    try {
      const base = await enviarBase({
        arquivo,
        mapeamento,
        oab: principal.oab,
        curso: principal.curso,
        nome: arquivo.name.replace(/\.csv$/i, ''),
        colunas: colunas.map((c) => c.nome),
        onProgresso: setProgresso,
      })
      setProgresso({ etapa: 'concluido', pct: 100 })
      const resultado = await criarAnalise({ dataset_id: base.id, turmas: turmasEscolhidas, nome })
      onConcluir(resultado)
    } catch (e) {
      if (e.status === 409 && e.corpo?.dataset) setDuplicado(e.corpo.dataset)
      else setErro(e.message)
    } finally {
      setProcessando(false)
      setProgresso(null)
    }
  }

  const analisarExistente = async () => {
    if (!duplicado || !turmasEscolhidas.length) return
    setProcessando(true)
    setErro(null)
    try {
      const resultado = await criarAnalise({
        dataset_id: duplicado.id,
        turmas: turmasEscolhidas,
        nome: `OAB ${turmasEscolhidas[0].oab} — ${turmasEscolhidas.length} turma(s)`,
      })
      onConcluir(resultado)
    } catch (e) {
      setErro(e.message)
    } finally {
      setProcessando(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-8">
      <p className="section-title">Nova análise</p>
      <h1 className="mt-1 font-display text-2xl font-bold text-ink-900 dark:text-white">
        Pesquisa de leads × compradores
      </h1>
      <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
        Suba o CSV da pesquisa, confirme as colunas e cruze com os alunos da turma. A base fica
        guardada no banco para você rodar de novo depois sem reenviar nada.
      </p>

      {!erroTurmas && turmas.length === 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm text-ink-700 dark:text-ink-100">
          <Info size={16} className="mt-0.5 shrink-0 text-accent-amber" />
          <span>
            Nenhuma turma no banco ainda. Rode <code className="rounded bg-ink-900/10 px-1 dark:bg-white/10">npm run sync:compradores</code> para
            trazer os alunos do RDS, ou informe a turma manualmente abaixo.
          </span>
        </div>
      )}

      {/* 1 — Upload */}
      <div
        className={`card mt-6 grid place-items-center border-2 border-dashed px-6 py-10 text-center transition
          ${arrastando ? 'border-vicio-400 bg-vicio-50/60 dark:bg-vicio-900/30' : 'border-ink-200 dark:border-ink-700'}`}
        onDragOver={(e) => { e.preventDefault(); setArrastando(true) }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => { e.preventDefault(); setArrastando(false); lerArquivo(e.dataTransfer.files?.[0]) }}
      >
        {arquivo ? (
          <div className="flex items-center gap-3">
            <FileSpreadsheet size={28} className="text-vicio-500" />
            <div className="text-left">
              <p className="text-sm font-semibold text-ink-800 dark:text-white">{arquivo.name}</p>
              <p className="text-xs text-ink-500 dark:text-ink-300">
                {(arquivo.size / 1024 / 1024).toFixed(1)} MB · {colunas.length} colunas detectadas
                {linhasAmostra >= 300 ? ' · amostra de 300 linhas' : ` · ${linhasAmostra} linhas`}
              </p>
            </div>
            <button className="btn-ghost ml-4" onClick={() => inputRef.current?.click()}>Trocar</button>
          </div>
        ) : (
          <button onClick={() => inputRef.current?.click()} className="flex flex-col items-center gap-3">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-vicio text-white shadow-glow-vicio">
              <UploadCloud size={24} />
            </span>
            <span className="text-sm font-semibold text-ink-800 dark:text-white">
              Arraste o CSV da pesquisa de leads ou clique para escolher
            </span>
            <span className="text-xs text-ink-500 dark:text-ink-300">
              Precisa conter e-mail do lead e as respostas da pesquisa
            </span>
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => lerArquivo(e.target.files?.[0])}
        />
      </div>

      {/* 2 — Mapeamento de colunas */}
      {colunas.length > 0 && (
        <div className="card mt-6 overflow-hidden">
          <div className="border-b border-ink-100/70 px-5 py-4 dark:border-ink-700/60">
            <p className="text-sm font-semibold text-ink-800 dark:text-white">Confirme o papel de cada coluna</p>
            <p className="text-xs text-ink-500 dark:text-ink-300">
              E-mail é obrigatório pro cruzamento. Telefone ajuda a achar quem comprou com outro e-mail.
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-ink-50/95 text-left text-xs uppercase tracking-wider text-ink-500 backdrop-blur dark:bg-ink-800/95 dark:text-ink-300">
                <tr>
                  <th className="px-5 py-2.5 font-semibold">Coluna</th>
                  <th className="px-3 py-2.5 font-semibold">Exemplos</th>
                  <th className="px-5 py-2.5 font-semibold">Papel</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100/70 dark:divide-ink-700/50">
                {colunas.map((c) => (
                  <tr key={c.nome} className={c.papel === 'ignorar' ? 'opacity-50' : ''}>
                    <td className="max-w-[16rem] truncate px-5 py-2.5 font-medium text-ink-800 dark:text-ink-100" title={c.nome}>
                      {c.nome}
                    </td>
                    <td className="max-w-[14rem] truncate px-3 py-2.5 text-xs text-ink-500 dark:text-ink-300" title={c.amostra.join(' · ')}>
                      {c.amostra.join(' · ') || '—'}
                    </td>
                    <td className="px-5 py-2.5">
                      <select
                        value={c.papel}
                        onChange={(e) => definirPapel(c.nome, e.target.value)}
                        className={`input !w-44 !py-1.5 ${c.papel === 'email' ? '!border-vicio-400' : ''} ${c.papel === 'pergunta' ? '!border-accent-cyan/60' : ''}`}
                      >
                        {PAPEIS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-ink-100/70 px-5 py-3 text-xs dark:border-ink-700/60">
            <span className={`chip ${mapeamento.email ? 'bg-vicio-100 text-vicio-800 dark:bg-vicio-900/60 dark:text-vicio-200' : 'bg-accent-rose/15 text-accent-rose'}`}>
              e-mail: {mapeamento.email || 'faltando!'}
            </span>
            <span className="chip bg-ink-100 text-ink-600 dark:bg-ink-700/60 dark:text-ink-200">
              telefone: {mapeamento.telefone || '—'}
            </span>
            <span className={`chip ${mapeamento.perguntas.length ? 'bg-accent-cyan/15 text-cyan-700 dark:text-accent-cyan' : 'bg-accent-rose/15 text-accent-rose'}`}>
              {mapeamento.perguntas.length} pergunta(s) da pesquisa
            </span>
          </div>
        </div>
      )}

      {/* 3 — Turma (compradores do banco) */}
      {colunas.length > 0 && (
        <div className="card mt-6 px-5 py-4">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-vicio-500" />
            <p className="text-sm font-semibold text-ink-800 dark:text-white">Compradores — turma no banco</p>
          </div>
          {erroTurmas ? (
            <div className="mt-3">
              <p className="text-xs text-accent-rose">
                Não consegui listar as turmas ({erroTurmas}). Informe manualmente:
              </p>
              <div className="mt-2 flex gap-3">
                <input className="input !w-32" type="number" placeholder="OAB (ex: 47)" value={oabManual} onChange={(e) => setOabManual(e.target.value)} />
                <input className="input !w-56" placeholder="Curso (ex: 90 dias)" value={cursoManual} onChange={(e) => setCursoManual(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <p className="mb-2 text-xs text-ink-500 dark:text-ink-300">
                Marque <strong>todos os produtos que essa captação vendeu</strong>. Quem entrou em
                qualquer um deles conta como comprador — deixar de fora um produto que converteu
                coloca esse pessoal no lado errado da conta e estraga os pesos.
              </p>
              <SeletorTurmas turmas={turmas} valor={turmasSel} onChange={setTurmasSel} />
            </div>
          )}
        </div>
      )}

      {duplicado && (
        <div className="mt-4 rounded-xl border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm text-ink-700 dark:text-ink-100">
          <div className="flex items-start gap-2">
            <Info size={16} className="mt-0.5 shrink-0 text-accent-amber" />
            <div>
              <p>
                Este arquivo já está no banco como <strong>{duplicado.nome}</strong>. Não precisa subir de novo.
              </p>
              <div className="mt-2 flex gap-2">
                <button className="btn-primary !py-1.5" onClick={analisarExistente} disabled={!turmasEscolhidas.length || processando}>
                  Analisar a base existente
                </button>
                <button className="btn-ghost !py-1.5" onClick={irParaBases}>Ver todas as bases</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {erro && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-accent-rose/40 bg-accent-rose/10 px-4 py-3 text-sm text-accent-rose">
          <AlertTriangle size={16} className="shrink-0" /> {erro}
        </div>
      )}

      {progresso && (
        <div className="card mt-4 px-5 py-4">
          <div className="flex items-center justify-between text-xs text-ink-600 dark:text-ink-200">
            <span>{ETAPAS[progresso.etapa] || 'Processando…'}</span>
            <span>
              {progresso.enviadas ? `${progresso.enviadas.toLocaleString('pt-BR')} leads · ` : ''}
              {progresso.pct}%
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-700">
            <div
              className="h-full rounded-full bg-gradient-vicio transition-[width] duration-300"
              style={{ width: `${progresso.pct}%` }}
            />
          </div>
        </div>
      )}

      {colunas.length > 0 && (
        <div className="mt-6 flex justify-end">
          <button className="btn-primary !px-6 !py-2.5" disabled={!pronto || processando} onClick={rodar}>
            {processando ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            {processando ? 'Enviando e cruzando…' : 'Enviar base e rodar análise'}
          </button>
        </div>
      )}
    </div>
  )
}
