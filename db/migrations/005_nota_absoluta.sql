-- Nota absoluta (comparável entre bases) para acompanhar a captação.
--
-- Até aqui o score era o percentil do lead DENTRO da própria base: qualquer base
-- tem sempre 20% de hot, então não dá para dizer se uma captação é boa ou ruim.
--
-- Agora, com p_referencia (101 quantis 0..100 da probabilidade nos leads de
-- treino do modelo), o score vira "quantos % dos leads de treino têm probabilidade
-- menor ou igual à deste lead". Um lead nota 80 está no topo 20% do histórico, e
-- uma base cuja nota média passa de 50 está captando acima do histórico.
-- Sem p_referencia (ou sem p_interceptos), mantém o percentil dentro da base.

drop function if exists leadscore.ls_aplicar_pesos_multi(uuid[], jsonb, jsonb);

create or replace function leadscore.ls_aplicar_pesos_multi(
  p_datasets uuid[], p_pesos jsonb, p_interceptos jsonb default null, p_referencia jsonb default null
)
returns jsonb
language plpgsql
as $$
declare
  v_faixas  jsonb;
  v_classes jsonb;
  v_ref     float8[];
begin
  if p_referencia is not null and p_interceptos is not null then
    select array_agg(x::float8 order by ord) into v_ref
      from jsonb_array_elements_text(p_referencia) with ordinality as t(x, ord);
  end if;

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
  com_prob as (
    select id, dataset_id, s,
           case when p_interceptos is null then null
                else 1 / (1 + exp(-(s + coalesce(
                       (p_interceptos ->> dataset_id::text)::float8,
                       (p_interceptos ->> '*')::float8, 0))))
           end as prob
      from bruto
  ),
  pct as (
    select id, prob,
           case
             when v_ref is not null then
               least(100, greatest(0, (select count(*) from unnest(v_ref) r where r <= com_prob.prob) - 1))::int
             else round(100 * percent_rank() over (partition by dataset_id order by s))::int
           end as score
      from com_prob
  )
  update leadscore.leads l
     set score  = pct.score,
         prob   = pct.prob,
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
                  else round(g.compras::numeric / g.leads, 4) end as taxa,
             g.prob_media
        from generate_series(0, 9) as d(ord)
        left join (
          select least(score / 10, 9) as ord, count(*) as leads,
                 count(*) filter (where comprou) as compras,
                 round(avg(prob)::numeric, 4) as prob_media
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
