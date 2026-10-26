-- Dimensões de análise do lead que NÃO entram no modelo: campanha, criativo,
-- público (utm_campaign, utm_content, utm_medium, utm_term…). Servem para a tela
-- Captação mostrar onde a captação está trazendo leads melhores ou piores.
alter table leadscore.leads add column if not exists extras jsonb not null default '{}'::jsonb;
comment on column leadscore.leads.extras is
  'Colunas de contexto do cadastro (UTMs). Só análise, nunca variável do modelo.';
