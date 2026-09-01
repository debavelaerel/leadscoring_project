-- =============================================================================
-- Lead Score Vício — funções de análise
--
-- O trabalho pesado (cruzar 32 mil leads com os compradores, somar pesos e
-- calcular percentil) roda aqui dentro do Postgres. O Worker só orquestra e
-- faz a matemática pequena (lift, V de Cramér) sobre os agregados.
-- =============================================================================

-- ------------------------------------------------------------------ turmas ---
-- Combinações (oab, curso) disponíveis no espelho de compradores.
create or replace function public.ls_turmas()
returns table (oab int, curso text, alunos bigint)
language sql
stable
as $$
  select c.oab, c.curso, count(*)::bigint as alunos
    from public.compradores c
   group by c.oab, c.curso
   order by c.oab desc, c.curso
$$;

-- ------------------------------------------------------------------ resumo ---
create or replace function public.ls_resumo(p_dataset uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'total_leads',        count(*),
    'total_compras',      count(*) filter (where comprou),
    'respondeu_pesquisa', count(*) filter (where respondeu)
  )
  from public.leads
  where dataset_id = p_dataset
$$;

-- ------------------------------------------------------------------- match ---
-- Marca quem comprou: e-mail exato primeiro, telefone como fallback.
-- Devolve quantos bateram por cada caminho (é o número que aparece no painel).
create or replace function public.ls_match_compradores(p_dataset uuid, p_oab int, p_curso text)
returns jsonb
language plpgsql
as $$
declare
  v_email int := 0;
  v_tel   int := 0;
  v_total int := 0;
begin
  update public.leads
     set comprou = false, match_via = null, score = null, classe = null
   where dataset_id = p_dataset;

  update public.leads l
     set comprou = true, match_via = 'email'
    from public.compradores c
   where l.dataset_id = p_dataset
     and c.oab = p_oab
     and c.curso = p_curso
     and l.email is not null
     and c.email is not null
     and l.email = c.email;
  get diagnostics v_email = row_count;

  update public.leads l
     set comprou = true, match_via = 'telefone'
   where l.dataset_id = p_dataset
     and l.comprou = false
     and l.tel_chaves <> '{}'
     and exists (
       select 1
         from public.compradores c
        where c.oab = p_oab
          and c.curso = p_curso
          and c.tel_chaves && l.tel_chaves
     );
  get diagnostics v_tel = row_count;

  select count(*) into v_total
    from public.compradores
   where oab = p_oab and curso = p_curso;

  return jsonb_build_object(
    'match_email',       v_email,
    'match_telefone',    v_tel,
    'compradores_banco', v_total
  );
end
$$;

-- ------------------------------------------------- cardinalidade das respostas
-- Pergunta com respostas demais é texto aberto e fica fora do modelo de pesos.
create or replace function public.ls_perguntas_distintas(p_dataset uuid, p_perguntas text[])
returns table (pergunta text, distintas bigint)
language sql
stable
as $$
  select q.pergunta,
         count(distinct nullif(l.respostas ->> q.pergunta, ''))::bigint
    from unnest(p_perguntas) as q(pergunta)
    cross join public.leads l
   where l.dataset_id = p_dataset
   group by q.pergunta
$$;

-- --------------------------------------------------------------- agregados ---
-- Tabela resposta × comprou, que é o insumo do cálculo de lift/peso/Cramér.
create or replace function public.ls_agregados(p_dataset uuid, p_perguntas text[])
returns table (pergunta text, resposta text, leads bigint, compras bigint)
language sql
stable
as $$
  select q.pergunta,
         coalesce(nullif(l.respostas ->> q.pergunta, ''), '(não respondeu)') as resposta,
         count(*)::bigint,
         count(*) filter (where l.comprou)::bigint
    from unnest(p_perguntas) as q(pergunta)
    cross join public.leads l
   where l.dataset_id = p_dataset
   group by 1, 2
$$;

-- ----------------------------------------------------------- aplicar pesos ---
-- Soma os pesos de cada lead, vira percentil 0–100 e classifica.
-- percent_rank() é exatamente a mesma conta do bisect_left/(n-1) do Python.
create or replace function public.ls_aplicar_pesos(p_dataset uuid, p_pesos jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_faixas  jsonb;
  v_classes jsonb;
begin
  if p_pesos is null or p_pesos = '{}'::jsonb then
    update public.leads set score = 0, classe = 'cold' where dataset_id = p_dataset;
  else
    with bruto as (
      select l.id,
             coalesce(sum(coalesce(
               (p_pesos -> q.pergunta ->> coalesce(nullif(l.respostas ->> q.pergunta, ''), '(não respondeu)'))::float8,
               0
             )), 0) as s
        from public.leads l
        cross join lateral jsonb_object_keys(p_pesos) as q(pergunta)
       where l.dataset_id = p_dataset
       group by l.id
    ),
    pct as (
      select id, round(100 * percent_rank() over (order by s))::int as score
        from bruto
    )
    update public.leads l
       set score  = pct.score,
           classe = case when pct.score >= 80 then 'hot'
                         when pct.score >= 50 then 'warm'
                         else 'cold' end
      from pct
     where l.id = pct.id;
  end if;

  -- calibração por decil de score
  select jsonb_agg(x order by x.ord) into v_faixas
    from (
      select d.ord,
             (d.ord * 10)::text || '–' || (case when d.ord = 9 then 100 else d.ord * 10 + 9 end)::text as faixa,
             coalesce(g.leads, 0)   as leads,
             coalesce(g.compras, 0) as compras,
             case when coalesce(g.leads, 0) = 0 then 0
                  else round(g.compras::numeric / g.leads, 4) end as taxa
        from generate_series(0, 9) as d(ord)
        left join (
          select least(score / 10, 9) as ord,
                 count(*) as leads,
                 count(*) filter (where comprou) as compras
            from public.leads
           where dataset_id = p_dataset and score is not null
           group by 1
        ) g on g.ord = d.ord
    ) x;

  select jsonb_object_agg(c.classe, jsonb_build_object('leads', c.leads, 'compras', c.compras))
    into v_classes
    from (
      select k.classe,
             count(l.id) as leads,
             count(l.id) filter (where l.comprou) as compras
        from (values ('hot'), ('warm'), ('cold')) as k(classe)
        left join public.leads l
               on l.dataset_id = p_dataset and l.classe = k.classe
       group by k.classe
    ) c;

  return jsonb_build_object(
    'faixas_score', coalesce(v_faixas, '[]'::jsonb),
    'classes',      coalesce(v_classes, '{}'::jsonb)
  );
end
$$;

-- ------------------------------------------------------- limpeza de dataset ---
create or replace function public.ls_zerar_leads(p_dataset uuid)
returns void
language sql
as $$
  delete from public.leads where dataset_id = p_dataset
$$;
