-- =============================================================================
-- Lead Score Vício — schema `leadscore` no RDS
--
-- Fica no mesmo banco do `plataforma1_espelho`, mas em schema separado: o
-- projeto só LÊ o espelho e só ESCREVE aqui dentro.
--
-- datasets          : cada CSV de pesquisa que subiu
-- dataset_arquivos  : o CSV original (gzip), guardado pra reprocessar depois
-- leads             : as linhas do CSV já normalizadas
-- analises          : o retrato congelado de uma rodada de score
--
-- Compradores NÃO viram tabela: saem direto do plataforma1_espelho no momento
-- do cruzamento, então nunca ficam defasados.
-- =============================================================================

create schema if not exists leadscore;

-- gen_random_uuid() é nativo no Postgres 13+. Em versões anteriores vem do
-- pgcrypto — tentamos criar a extensão, e se o usuário não tiver permissão o
-- erro aparece como aviso (aí é só pedir pra infra: CREATE EXTENSION pgcrypto).
do $$
begin
  perform gen_random_uuid();
exception
  when undefined_function then
    begin
      create extension if not exists pgcrypto;
    exception
      when others then
        raise exception 'Falta gen_random_uuid(): rode "create extension pgcrypto;" com um usuario que tenha permissao.';
    end;
end
$$;

-- ---------------------------------------------------------------- datasets ---
create table if not exists leadscore.datasets (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  arquivo_nome  text not null,
  bytes         bigint,
  hash          text,
  oab           int,
  curso         text,
  colunas       jsonb not null default '[]'::jsonb,
  mapeamento    jsonb,
  total_linhas  int   not null default 0,
  status        text  not null default 'enviando',   -- enviando | pronto | erro
  erro          text,
  criado_em     timestamptz not null default now()
);

comment on table  leadscore.datasets is 'Cada CSV de pesquisa de leads enviado ao painel.';
comment on column leadscore.datasets.hash is 'SHA-256 do arquivo — evita reenviar a mesma base.';

create index if not exists datasets_criado_idx on leadscore.datasets (criado_em desc);
create index if not exists datasets_turma_idx  on leadscore.datasets (oab, curso);
create unique index if not exists datasets_hash_uk on leadscore.datasets (hash) where hash is not null;

-- -------------------------------------------------------- dataset_arquivos ---
-- Tabela separada pra listagem de bases não arrastar o binário junto.
create table if not exists leadscore.dataset_arquivos (
  dataset_id  uuid primary key references leadscore.datasets(id) on delete cascade,
  conteudo    bytea not null,
  gzip        boolean not null default true,
  bytes       bigint  not null,
  criado_em   timestamptz not null default now()
);

comment on table leadscore.dataset_arquivos is 'CSV original comprimido — fonte pra reprocessar com outro mapeamento de colunas.';

-- ------------------------------------------------------------------- leads ---
create table if not exists leadscore.leads (
  id            bigserial primary key,
  dataset_id    uuid not null references leadscore.datasets(id) on delete cascade,
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

comment on column leadscore.leads.tel_chaves is
  'Variantes do telefone (com e sem o 9o digito) — mesma regra do painel de aprovados.';

create index if not exists leads_dataset_idx   on leadscore.leads (dataset_id);
create index if not exists leads_email_idx     on leadscore.leads (dataset_id, email) where email is not null;
create index if not exists leads_score_idx     on leadscore.leads (dataset_id, score desc);
create index if not exists leads_classe_idx    on leadscore.leads (dataset_id, classe);
create index if not exists leads_telchaves_idx on leadscore.leads using gin (tel_chaves);
create unique index if not exists leads_dataset_linha_uk on leadscore.leads (dataset_id, linha);

-- ---------------------------------------------------------------- analises ---
create table if not exists leadscore.analises (
  id          uuid primary key default gen_random_uuid(),
  dataset_id  uuid not null references leadscore.datasets(id) on delete cascade,
  nome        text not null default '',
  oab         int,
  curso       text,
  meta        jsonb not null default '{}'::jsonb,
  stats       jsonb not null default '{}'::jsonb,
  pesos       jsonb not null default '{}'::jsonb,
  criada_em   timestamptz not null default now()
);

comment on column leadscore.analises.pesos is
  'Pesos por pergunta/resposta — e este JSON que alimenta o modulo do Optimiz.';

create index if not exists analises_dataset_idx on leadscore.analises (dataset_id);
create index if not exists analises_criada_idx  on leadscore.analises (criada_em desc);
