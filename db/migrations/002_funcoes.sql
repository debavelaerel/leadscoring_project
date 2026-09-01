-- =============================================================================
-- Lead Score Vício — funções do schema `leadscore`
--
-- O trabalho pesado roda aqui: cruzar 32 mil leads com os alunos matriculados,
-- somar pesos e calcular percentil. O Worker só orquestra e faz a matemática
-- pequena (lift, V de Cramér) sobre os agregados.
--
-- Os helpers de normalização abaixo são o espelho exato de worker/src/etl.ts —
-- se um mudar, o outro muda junto (tem teste de paridade cobrindo isso).
-- =============================================================================

-- ------------------------------------------------------ normalização (ETL) ---

create or replace function leadscore.limpar_email(bruto text)
returns text
language sql
immutable
as $$
  select case
    when lower(btrim(bruto)) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    then lower(btrim(bruto))
  end
$$;

comment on function leadscore.limpar_email(text) is 'Mesma regra do EMAIL_RE em worker/src/etl.ts.';

create or replace function leadscore.tel_chaves(bruto text)
returns text[]
language plpgsql
immutable
as $$
declare
  d      text;
  ddd    text;
  num    text;
  chaves text[] := '{}';
begin
  if bruto is null then return chaves; end if;

  d := regexp_replace(bruto, '[^0-9]', '', 'g');
  if length(d) >= 12 and left(d, 2) = '55' then
    d := substr(d, 3);
  end if;
  if length(d) < 3 then return chaves; end if;

  ddd := left(d, 2);
  num := substr(d, 3);
  if length(num) < 8 then return chaves; end if;

  chaves := array[ddd || num];
  if length(num) = 9 and left(num, 1) = '9' then
    chaves := chaves || (ddd || substr(num, 2));   -- variante sem o 9º dígito
  elsif length(num) = 8 then
    chaves := chaves || (ddd || '9' || num);       -- variante com o 9º dígito
  end if;
  return chaves;
end
$$;

comment on function leadscore.tel_chaves(text) is 'Mesma regra de limparTelefone + chavesTelefone em worker/src/etl.ts.';

-- ------------------------------------------------- leitura do espelho -------

-- Combinações (oab, curso) com alunos ativos — alimenta o seletor de turma.
create or replace function leadscore.ls_turmas()
returns table (oab int, curso text, alunos bigint)
language sql
stable
as $$
  select c.oab, c.classroom_type_name as curso, count(*)::bigint as alunos
    from plataforma1_espelho.user_on_classroom uoc
    join plataforma1_espelho.classroom c on c.id = uoc.classroom_id
    join plataforma1_espelho.user_ u     on u.id = uoc.user_id
   where u.role = 'STUDENT'
     and uoc.status is true
     and c.oab is not null
   group by c.oab, c.classroom_type_name
   order by c.oab desc, curso
$$;

-- Compradores da turma, já normalizados. Nada é materializado: sempre ao vivo.
create or replace function leadscore.ls_compradores(p_oab int, p_curso text)
returns table (email text, chaves text[])
language sql
stable
as $$
  select distinct
         leadscore.limpar_email(u.email),
         leadscore.tel_chaves(u.cellphone)
    from plataforma1_espelho.user_on_classroom uoc
    join plataforma1_espelho.classroom c on c.id = uoc.classroom_id
    join plataforma1_espelho.user_ u     on u.id = uoc.user_id
   where u.role = 'STUDENT'
     and uoc.status is true
     and c.oab = p_oab
     and c.classroom_type_name = p_curso
$$;

-- ------------------------------------------------------------------ resumo ---
create or replace function leadscore.ls_resumo(p_dataset uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'total_leads',        count(*),
    'total_compras',      count(*) filter (where comprou),
    'respondeu_pesquisa', count(*) filter (where respondeu)
  )
  from leadscore.leads
  where dataset_id = p_dataset
$$;

-- ------------------------------------------------------------------- match ---
-- E-mail exato primeiro; telefone só pra quem sobrou.
create or replace function leadscore.ls_match_compradores(p_dataset uuid, p_oab int, p_curso text)
returns jsonb
language plpgsql
as $$
declare
  v_email  int := 0;
  v_tel    int := 0;
  v_total  int := 0;
  v_emails text[];
  v_chaves text[];
begin
  update leadscore.leads
     set comprou = false, match_via = null, score = null, classe = null
   where dataset_id = p_dataset;

  -- puxa a turma do espelho uma vez e reduz a dois arrays (sem tabela temporária,
  -- que quebraria o plano em cache quando a conexão é reaproveitada)
  with c as (
    select * from leadscore.ls_compradores(p_oab, p_curso)
  ),
  ch as (
    select distinct k from c, unnest(c.chaves) as k
  )
  select (select count(*) from c),
         (select coalesce(array_agg(distinct c2.email), '{}') from c c2 where c2.email is not null),
         (select coalesce(array_agg(ch.k), '{}') from ch)
    into v_total, v_emails, v_chaves;

  if array_length(v_emails, 1) > 0 then
    update leadscore.leads l
       set comprou = true, match_via = 'email'
     where l.dataset_id = p_dataset
       and l.email = any(v_emails);
    get diagnostics v_email = row_count;
  end if;

  -- um array só com todas as chaves: assim o índice GIN de tel_chaves entra em ação
  if array_length(v_chaves, 1) > 0 then
    update leadscore.leads l
       set comprou = true, match_via = 'telefone'
     where l.dataset_id = p_dataset
       and l.comprou = false
       and l.tel_chaves && v_chaves;
    get diagnostics v_tel = row_count;
  end if;

  return jsonb_build_object(
    'match_email',       v_email,
    'match_telefone',    v_tel,
    'compradores_banco', v_total
  );
end
$$;

-- ------------------------------------------------- cardinalidade das respostas
-- Pergunta com respostas demais é texto aberto e fica fora do modelo de pesos.
create or replace function leadscore.ls_perguntas_distintas(p_dataset uuid, p_perguntas text[])
returns table (pergunta text, distintas bigint)
language sql
stable
as $$
  select q.pergunta,
         count(distinct nullif(l.respostas ->> q.pergunta, ''))::bigint
    from unnest(p_perguntas) as q(pergunta)
    cross join leadscore.leads l
   where l.dataset_id = p_dataset
   group by q.pergunta
$$;

-- --------------------------------------------------------------- agregados ---
create or replace function leadscore.ls_agregados(p_dataset uuid, p_perguntas text[])
returns table (pergunta text, resposta text, leads bigint, compras bigint)
language sql
stable
as $$
  select q.pergunta,
         coalesce(nullif(l.respostas ->> q.pergunta, ''), '(não respondeu)') as resposta,
         count(*)::bigint,
         count(*) filter (where l.comprou)::bigint
    from unnest(p_perguntas) as q(pergunta)
    cross join leadscore.leads l
   where l.dataset_id = p_dataset
   group by 1, 2
$$;

-- ----------------------------------------------------------- aplicar pesos ---
-- percent_rank() é exatamente a mesma conta do bisect_left/(n-1) do Python.
create or replace function leadscore.ls_aplicar_pesos(p_dataset uuid, p_pesos jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_faixas  jsonb;
  v_classes jsonb;
begin
  if p_pesos is null or p_pesos = '{}'::jsonb then
    update leadscore.leads set score = 0, classe = 'cold' where dataset_id = p_dataset;
  else
    with bruto as (
      select l.id,
             coalesce(sum(coalesce(
               (p_pesos -> q.pergunta ->> coalesce(nullif(l.respostas ->> q.pergunta, ''), '(não respondeu)'))::float8,
               0
             )), 0) as s
        from leadscore.leads l
        cross join lateral jsonb_object_keys(p_pesos) as q(pergunta)
       where l.dataset_id = p_dataset
       group by l.id
    ),
    pct as (
      select id, round(100 * percent_rank() over (order by s))::int as score
        from bruto
    )
    update leadscore.leads l
       set score  = pct.score,
           classe = case when pct.score >= 80 then 'hot'
                         when pct.score >= 50 then 'warm'
                         else 'cold' end
      from pct
     where l.id = pct.id;
  end if;

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
            from leadscore.leads
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
        left join leadscore.leads l
               on l.dataset_id = p_dataset and l.classe = k.classe
       group by k.classe
    ) c;

  return jsonb_build_object(
    'faixas_score', coalesce(v_faixas, '[]'::jsonb),
    'classes',      coalesce(v_classes, '{}'::jsonb)
  );
end
$$;
