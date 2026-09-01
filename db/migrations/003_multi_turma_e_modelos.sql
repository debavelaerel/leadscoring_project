-- =============================================================================
-- Lead Score Vício — múltiplas turmas por análise + modelo combinado
--
-- Duas mudanças que existem pelo mesmo motivo: acurácia.
--
-- 1. Uma captação vende vários produtos (40D, 60D, 90D, 150D, 180D). Marcar
--    como comprador só quem entrou na 90D joga quem comprou 40D pro lado dos
--    não-compradores — isso não só perde sinal, inverte o sinal de gente que
--    converteu. Agora a análise cruza com um conjunto de turmas.
--
-- 2. Um lançamento só dá poucas dezenas de compras por resposta. Empilhando
--    edições (OAB 45 + 47) cada célula ganha amostra. O peso é a média
--    ponderada do log-lift calculado DENTRO de cada base — nunca sobre a soma
--    crua, senão a diferença de taxa base entre lançamentos vira sinal falso
--    (paradoxo de Simpson).
-- =============================================================================

-- em qual(is) turma(s) o lead entrou — '{}' para quem não comprou
alter table leadscore.leads
  add column if not exists comprou_em text[] not null default '{}';

comment on column leadscore.leads.comprou_em is
  'Turmas em que o lead se matriculou, no formato "oab|curso".';

-- ----------------------------------------------------------------- modelos ---
create table if not exists leadscore.modelos (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null default '',
  datasets    uuid[] not null,
  perguntas   text[] not null,
  pesos       jsonb  not null default '{}'::jsonb,
  stats       jsonb  not null default '{}'::jsonb,
  validacao   jsonb  not null default '{}'::jsonb,
  criado_em   timestamptz not null default now()
);

comment on table leadscore.modelos is
  'Modelo treinado sobre uma ou mais bases. `pesos` é o JSON que alimenta o Optimiz.';

create index if not exists modelos_criado_idx on leadscore.modelos (criado_em desc);

-- ------------------------------------------------------- match multi-turma ---
-- p_turmas: [{"oab":47,"curso":"90D"}, {"oab":47,"curso":"40D"}]
create or replace function leadscore.ls_match_turmas(p_dataset uuid, p_turmas jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_email  int := 0;
  v_tel    int := 0;
  v_total  int := 0;
  v_emails text[];
  v_chaves text[];
  v_por_turma jsonb := '[]'::jsonb;
begin
  update leadscore.leads
     set comprou = false, match_via = null, comprou_em = '{}', score = null, classe = null
   where dataset_id = p_dataset;

  -- todos os alunos das turmas pedidas, já normalizados e com a etiqueta da turma
  create temporary table if not exists _turmas_alvo (oab int, curso text) on commit drop;
  delete from _turmas_alvo;
  insert into _turmas_alvo (oab, curso)
  select (t ->> 'oab')::int, t ->> 'curso' from jsonb_array_elements(p_turmas) as t;

  with alunos as (
    select distinct
           leadscore.limpar_email(u.email)      as email,
           leadscore.tel_chaves(u.cellphone)    as chaves,
           c.oab || '|' || c.classroom_type_name as turma
      from _turmas_alvo a
      join plataforma1_espelho.classroom c
        on c.oab = a.oab and c.classroom_type_name = a.curso
      join plataforma1_espelho.user_on_classroom uoc on uoc.classroom_id = c.id
      join plataforma1_espelho.user_ u on u.id = uoc.user_id
     where u.role = 'STUDENT' and uoc.status is true
  ),
  ch as (select distinct k from alunos, unnest(alunos.chaves) as k)
  select (select count(*) from alunos),
         (select coalesce(array_agg(distinct a.email), '{}') from alunos a where a.email is not null),
         (select coalesce(array_agg(ch.k), '{}') from ch)
    into v_total, v_emails, v_chaves;

  -- 1) e-mail exato
  if array_length(v_emails, 1) > 0 then
    update leadscore.leads l
       set comprou = true, match_via = 'email'
     where l.dataset_id = p_dataset
       and l.email = any(v_emails);
    get diagnostics v_email = row_count;
  end if;

  -- 2) telefone, só pra quem não bateu por e-mail
  if array_length(v_chaves, 1) > 0 then
    update leadscore.leads l
       set comprou = true, match_via = 'telefone'
     where l.dataset_id = p_dataset
       and l.comprou = false
       and l.tel_chaves && v_chaves;
    get diagnostics v_tel = row_count;
  end if;

  -- 3) etiqueta de qual turma cada comprador entrou (pode ser mais de uma)
  with alunos as (
    select distinct
           leadscore.limpar_email(u.email)      as email,
           leadscore.tel_chaves(u.cellphone)    as chaves,
           c.oab || '|' || c.classroom_type_name as turma
      from _turmas_alvo a
      join plataforma1_espelho.classroom c
        on c.oab = a.oab and c.classroom_type_name = a.curso
      join plataforma1_espelho.user_on_classroom uoc on uoc.classroom_id = c.id
      join plataforma1_espelho.user_ u on u.id = uoc.user_id
     where u.role = 'STUDENT' and uoc.status is true
  ),
  casados as (
    select l.id, array_agg(distinct a.turma) as turmas
      from leadscore.leads l
      join alunos a
        on (a.email is not null and a.email = l.email)
        or (a.chaves <> '{}' and a.chaves && l.tel_chaves)
     where l.dataset_id = p_dataset and l.comprou
     group by l.id
  )
  update leadscore.leads l
     set comprou_em = casados.turmas
    from casados
   where l.id = casados.id;

  select coalesce(jsonb_agg(x order by x.compras desc), '[]'::jsonb) into v_por_turma
    from (
      select t as turma, count(*)::int as compras
        from leadscore.leads l, unnest(l.comprou_em) as t
       where l.dataset_id = p_dataset
       group by t
    ) x;

  return jsonb_build_object(
    'match_email',       v_email,
    'match_telefone',    v_tel,
    'compradores_banco', v_total,
    'por_turma',         v_por_turma
  );
end
$$;

-- ------------------------------------------------------- perguntas comuns ----
create or replace function leadscore.ls_perguntas_comuns(p_datasets uuid[])
returns table (pergunta text, bases bigint)
language sql
stable
as $$
  select p.pergunta, count(distinct d.id)::bigint as bases
    from leadscore.datasets d
    cross join lateral jsonb_array_elements_text(coalesce(d.mapeamento -> 'perguntas', '[]'::jsonb)) as p(pergunta)
   where d.id = any(p_datasets)
   group by p.pergunta
   order by bases desc, p.pergunta
$$;

-- --------------------------------------------------- agregados por base ------
-- Igual ao ls_agregados, mas mantendo o dataset_id: o peso combinado precisa
-- saber de qual base veio cada contagem.
create or replace function leadscore.ls_agregados_multi(p_datasets uuid[], p_perguntas text[])
returns table (dataset_id uuid, pergunta text, resposta text, leads bigint, compras bigint)
language sql
stable
as $$
  select l.dataset_id,
         q.pergunta,
         coalesce(nullif(l.respostas ->> q.pergunta, ''), '(não respondeu)') as resposta,
         count(*)::bigint,
         count(*) filter (where l.comprou)::bigint
    from unnest(p_perguntas) as q(pergunta)
    cross join leadscore.leads l
   where l.dataset_id = any(p_datasets)
   group by 1, 2, 3
$$;

create or replace function leadscore.ls_resumo_multi(p_datasets uuid[])
returns table (dataset_id uuid, total_leads bigint, total_compras bigint, respondeu bigint)
language sql
stable
as $$
  select dataset_id,
         count(*)::bigint,
         count(*) filter (where comprou)::bigint,
         count(*) filter (where respondeu)::bigint
    from leadscore.leads
   where dataset_id = any(p_datasets)
   group by dataset_id
$$;

-- ------------------------------------------- aplicar pesos em várias bases ---
-- O percentil é calculado DENTRO de cada base: "hot" quer dizer top 20% da
-- própria lista, que é como o comercial usa.
create or replace function leadscore.ls_aplicar_pesos_multi(p_datasets uuid[], p_pesos jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_faixas  jsonb;
  v_classes jsonb;
begin
  with bruto as (
    select l.id, l.dataset_id,
           coalesce(sum(coalesce(
             (p_pesos -> q.pergunta ->> coalesce(nullif(l.respostas ->> q.pergunta, ''), '(não respondeu)'))::float8,
             0
           )), 0) as s
      from leadscore.leads l
      cross join lateral jsonb_object_keys(p_pesos) as q(pergunta)
     where l.dataset_id = any(p_datasets)
     group by l.id, l.dataset_id
  ),
  pct as (
    select id,
           round(100 * percent_rank() over (partition by dataset_id order by s))::int as score
      from bruto
  )
  update leadscore.leads l
     set score  = pct.score,
         classe = case when pct.score >= 80 then 'hot'
                       when pct.score >= 50 then 'warm'
                       else 'cold' end
    from pct
   where l.id = pct.id;

  select jsonb_agg(x order by x.ord) into v_faixas
    from (
      select d.ord,
             (d.ord * 10)::text || '–' || (case when d.ord = 9 then 100 else d.ord * 10 + 9 end)::text as faixa,
             coalesce(g.leads, 0) as leads, coalesce(g.compras, 0) as compras,
             case when coalesce(g.leads, 0) = 0 then 0
                  else round(g.compras::numeric / g.leads, 4) end as taxa
        from generate_series(0, 9) as d(ord)
        left join (
          select least(score / 10, 9) as ord, count(*) as leads,
                 count(*) filter (where comprou) as compras
            from leadscore.leads
           where dataset_id = any(p_datasets) and score is not null
           group by 1
        ) g on g.ord = d.ord
    ) x;

  select jsonb_object_agg(c.classe, jsonb_build_object('leads', c.leads, 'compras', c.compras))
    into v_classes
    from (
      select k.classe, count(l.id) as leads, count(l.id) filter (where l.comprou) as compras
        from (values ('hot'), ('warm'), ('cold')) as k(classe)
        left join leadscore.leads l
               on l.dataset_id = any(p_datasets) and l.classe = k.classe
       group by k.classe
    ) c;

  return jsonb_build_object(
    'faixas_score', coalesce(v_faixas, '[]'::jsonb),
    'classes',      coalesce(v_classes, '{}'::jsonb)
  );
end
$$;

-- ------------------------------------------------------------- validação ----
-- Pontua uma base SEM gravar nada: é assim que se mede um modelo treinado em
-- outras bases. Devolve AUC, lift do decil topo e captura dos hot.
create or replace function leadscore.ls_validar(p_dataset uuid, p_pesos jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v jsonb;
begin
  with bruto as (
    select l.id, l.comprou,
           coalesce(sum(coalesce(
             (p_pesos -> q.pergunta ->> coalesce(nullif(l.respostas ->> q.pergunta, ''), '(não respondeu)'))::float8,
             0
           )), 0) as s
      from leadscore.leads l
      cross join lateral jsonb_object_keys(p_pesos) as q(pergunta)
     where l.dataset_id = p_dataset
     group by l.id, l.comprou
  ),
  pct as (
    select id, comprou, s,
           round(100 * percent_rank() over (order by s))::int as score,
           -- rank médio (empates contam metade), pra AUC de Mann-Whitney
           rank() over (order by s) + (count(*) over (partition by s) - 1) / 2.0 as rk
      from bruto
  ),
  base as (
    select count(*)::numeric                                   as n,
           count(*) filter (where comprou)::numeric            as compras,
           sum(rk) filter (where comprou)                      as soma_rk_pos
      from pct
  ),
  topo as (
    select count(*)::numeric as n, count(*) filter (where comprou)::numeric as compras
      from pct where score >= 90
  ),
  quentes as (
    select count(*)::numeric as n, count(*) filter (where comprou)::numeric as compras
      from pct where score >= 80
  )
  select jsonb_build_object(
    'leads',           base.n::int,
    'compras',         base.compras::int,
    'taxa_base',       case when base.n = 0 then 0 else round(base.compras / base.n, 4) end,
    'auc',             case
                         when base.compras = 0 or base.compras = base.n then null
                         else round(
                           (base.soma_rk_pos - base.compras * (base.compras + 1) / 2)
                           / (base.compras * (base.n - base.compras)), 4)
                       end,
    'taxa_decil_topo', case when topo.n = 0 then 0 else round(topo.compras / topo.n, 4) end,
    'lift_decil_topo', case when topo.n = 0 or base.compras = 0 then 0
                            else round((topo.compras / topo.n) / (base.compras / base.n), 2) end,
    'taxa_hot',        case when quentes.n = 0 then 0 else round(quentes.compras / quentes.n, 4) end,
    'lift_hot',        case when quentes.n = 0 or base.compras = 0 then 0
                            else round((quentes.compras / quentes.n) / (base.compras / base.n), 2) end,
    'captura_hot',     case when base.compras = 0 then 0
                            else round(quentes.compras / base.compras, 4) end,
    'fatia_hot',       case when base.n = 0 then 0 else round(quentes.n / base.n, 4) end
  ) into v
  from base, topo, quentes;

  return v;
end
$$;
