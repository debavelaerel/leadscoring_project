-- =============================================================================
-- Usuário de aplicação do Lead Score
--
-- Hoje o Worker conecta como `athilav7`, que é SUPERUSER e dono do
-- `plataforma1_espelho`. Como o banco aceita conexão da internet na 5432 e
-- recusa TLS, essa credencial de superusuário atravessa a rede aberta em texto
-- puro a cada requisição. Este script cria o usuário mínimo que o projeto
-- precisa, para substituí-la.
--
-- O que `leadscore_app` pode:
--   · ler o `plataforma1_espelho` (SELECT, nada além disso)
--   · mandar no schema `leadscore` — inclusive rodar migrations, porque recebe
--     a posse dos objetos
--
-- O que ele NÃO pode:
--   · escrever no espelho, nem por bug nem por injection
--   · criar banco, criar papel, replicar, ignorar RLS
--   · ser superusuário
--
-- COMO RODAR
--   1. Troque TROQUE_ESTA_SENHA por uma senha forte (ex.: `openssl rand -base64 24`)
--   2. Rode como um usuário com poder de criar papéis (o athilav7 serve):
--        psql "postgres://athilav7:SENHA@56.126.74.248:5432/postgres" -f db/roles/leadscore_app.sql
--   3. Grave a nova URL no Worker:
--        npx wrangler secret put DATABASE_URL
--        # postgres://leadscore_app:SENHA@56.126.74.248:5432/postgres?sslmode=disable
--
-- NÃO comite a senha. Este arquivo só deve conter o placeholder.
-- =============================================================================

begin;

-- ------------------------------------------------------------------ papel ---
create role leadscore_app with
  login
  password 'TROQUE_ESTA_SENHA'
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls;

grant connect, temporary on database postgres to leadscore_app;
-- `temporary` é necessário: leadscore.ls_match_turmas() cria uma temp table.

-- -------------------------------------------------- espelho: só leitura ---
grant usage on schema plataforma1_espelho to leadscore_app;
grant select on all tables in schema plataforma1_espelho to leadscore_app;

-- tabelas que o athilav7 criar no espelho daqui pra frente já nascem legíveis
alter default privileges for role athilav7 in schema plataforma1_espelho
  grant select on tables to leadscore_app;

-- ------------------------------------------- leadscore: domínio completo ---
grant usage, create on schema leadscore to leadscore_app;

-- A posse é o que permite rodar migrations: `alter table` exige ser dono, e
-- `grant all` não dá isso. O schema é do projeto, então o usuário do projeto
-- deve ser o dono dele.
alter schema leadscore owner to leadscore_app;

do $$
declare r record;
begin
  for r in
    select c.relname, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'leadscore'
       and c.relkind in ('r', 'S', 'v', 'm')
       -- sequence de coluna serial/identity não troca de dono sozinha: ela
       -- segue a tabela. Tentar trocar dá "cannot change owner of sequence".
       and not (c.relkind = 'S' and exists (
             select 1
               from pg_depend d
              where d.classid = 'pg_class'::regclass
                and d.objid = c.oid
                and d.deptype = 'a'))
  loop
    execute format(
      'alter %s leadscore.%I owner to leadscore_app',
      case r.relkind
        when 'r' then 'table'
        when 'S' then 'sequence'
        when 'v' then 'view'
        else 'materialized view'
      end,
      r.relname
    );
  end loop;

  -- índices seguem a posse da tabela; funções precisam ser tratadas à parte
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'leadscore'
  loop
    execute format('alter function %s owner to leadscore_app', r.sig);
  end loop;
end $$;

commit;

-- =============================================================================
-- Conferência — rode como leadscore_app e confirme que o resultado bate:
--
--   select current_user, usesuper from pg_user where usename = current_user;
--     -> leadscore_app | f
--
--   select count(*) from plataforma1_espelho.user_;        -- funciona
--   update plataforma1_espelho.user_ set email = email;    -- DEVE falhar
--   select count(*) from leadscore.leads;                  -- funciona
--   select * from leadscore.ls_turmas() limit 1;           -- funciona
-- =============================================================================
