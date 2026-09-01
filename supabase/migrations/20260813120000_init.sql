-- =============================================================================
-- Lead Score Vício — schema inicial
--
-- datasets    : cada CSV de pesquisa que subiu (o arquivo bruto fica no Storage)
-- leads       : as linhas do CSV já normalizadas (e-mail/telefone limpos)
-- compradores : espelho dos alunos matriculados, sincronizado do RDS
-- analises    : o retrato congelado de uma rodada de score
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- datasets ---
create table if not exists public.datasets (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  arquivo_nome  text not null,
  storage_path  text,
  bytes         bigint,
  hash          text,
  oab           int,
  curso         text,
  colunas       jsonb  not null default '[]'::jsonb,
  mapeamento    jsonb,
  total_linhas  int    not null default 0,
  status        text   not null default 'enviando',   -- enviando | pronto | erro
  erro          text,
  criado_em     timestamptz not null default now()
);

comment on table public.datasets is 'Cada CSV de pesquisa de leads enviado ao painel.';
comment on column public.datasets.hash is 'SHA-256 do arquivo — usado para avisar de reenvio duplicado.';

create index if not exists datasets_criado_idx on public.datasets (criado_em desc);
create index if not exists datasets_turma_idx  on public.datasets (oab, curso);
create unique index if not exists datasets_hash_uk on public.datasets (hash) where hash is not null;

-- ------------------------------------------------------------------- leads ---
create table if not exists public.leads (
  id            bigserial primary key,
  dataset_id    uuid not null references public.datasets(id) on delete cascade,
  linha         int  not null,
  nome          text not null default '',
  email         text,
  telefone_fmt  text not null default '',
  tel_chaves    text[] not null default '{}',
  data_lead     text not null default '',
  respostas     jsonb  not null default '{}'::jsonb,
  respondeu     boolean not null default false,
  comprou       boolean not null default false,
  match_via     text,
  score         int,
  classe        text
);

comment on column public.leads.tel_chaves is
  'Variantes do telefone (com e sem o 9o digito) usadas no match — mesma regra do painel de aprovados.';

create index if not exists leads_dataset_idx    on public.leads (dataset_id);
create index if not exists leads_email_idx      on public.leads (dataset_id, email) where email is not null;
create index if not exists leads_score_idx      on public.leads (dataset_id, score desc);
create index if not exists leads_classe_idx     on public.leads (dataset_id, classe);
create index if not exists leads_telchaves_idx  on public.leads using gin (tel_chaves);
create unique index if not exists leads_dataset_linha_uk on public.leads (dataset_id, linha);

-- ------------------------------------------------------------- compradores ---
create table if not exists public.compradores (
  id               bigserial primary key,
  oab              int  not null,
  curso            text not null,
  email            text,
  telefone         text,
  tel_chaves       text[] not null default '{}',
  sincronizado_em  timestamptz not null default now()
);

comment on table public.compradores is
  'Espelho dos alunos ativos (plataforma1_espelho) por edicao/turma. Populado por scripts/sync-compradores.mjs.';

create unique index if not exists compradores_uk on public.compradores
  (oab, curso, coalesce(email, ''), coalesce(telefone, ''));
create index if not exists compradores_turma_idx     on public.compradores (oab, curso);
create index if not exists compradores_email_idx     on public.compradores (email) where email is not null;
create index if not exists compradores_telchaves_idx on public.compradores using gin (tel_chaves);

-- ---------------------------------------------------------------- analises ---
create table if not exists public.analises (
  id          uuid primary key default gen_random_uuid(),
  dataset_id  uuid not null references public.datasets(id) on delete cascade,
  nome        text not null default '',
  oab         int,
  curso       text,
  meta        jsonb not null default '{}'::jsonb,
  stats       jsonb not null default '{}'::jsonb,
  pesos       jsonb not null default '{}'::jsonb,
  criada_em   timestamptz not null default now()
);

comment on column public.analises.pesos is
  'Pesos por pergunta/resposta — e este JSON que alimenta o modulo do Optimiz.';

create index if not exists analises_dataset_idx on public.analises (dataset_id);
create index if not exists analises_criada_idx  on public.analises (criada_em desc);

-- --------------------------------------------------------------------- RLS ---
-- Sem policies: so a service_role (usada pelo Worker) enxerga estas tabelas.
-- A anon key nao le nem escreve nada. Quando entrar auth de usuario, as
-- policies entram aqui.
alter table public.datasets    enable row level security;
alter table public.leads       enable row level security;
alter table public.compradores enable row level security;
alter table public.analises    enable row level security;
