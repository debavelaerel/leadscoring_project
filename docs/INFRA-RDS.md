# Pedido para a infra — RDS do Lead Score

O painel Lead Score precisa de um Postgres. Este documento é o que a infra
precisa provisionar, e por quê.

## Situação atual

O host que o projeto usava — `adf6bf1a3e13547689c2f8c223647464-984e0b66db785574.elb.sa-east-1.amazonaws.com`
— **não resolve mais em DNS** (NXDOMAIN). O Elastic Load Balancer foi removido.
Enquanto não houver um endpoint novo, o painel sobe mas toda chamada de API falha.

## 1. A instância

| Item | Valor | Porquê |
|---|---|---|
| Engine | PostgreSQL **13 ou superior** | `gen_random_uuid()` é nativo a partir do 13. Em versão anterior, é preciso `CREATE EXTENSION pgcrypto` com um usuário privilegiado. |
| Região | `sa-east-1` | Mesma região do resto; latência com a borda da Cloudflare. |
| Database | `postgres` (ou nome definido pela infra) | Só precisa ser o mesmo informado na connection string. |

## 2. O ponto que não pode ser negociado: o espelho no mesmo banco

O schema `leadscore` **não é autossuficiente**. As funções de cruzamento fazem
JOIN direto com o `plataforma1_espelho`, no mesmo banco — é assim que os
compradores nunca ficam defasados (não existe cópia nem sincronismo).

Ver `db/migrations/002_funcoes.sql:71` e `db/migrations/003_multi_turma_e_modelos.sql:72`.

Objetos do espelho efetivamente lidos:

| Tabela | Colunas usadas |
|---|---|
| `plataforma1_espelho.user_` | `id`, `email`, `cellphone`, `role` |
| `plataforma1_espelho.classroom` | `id`, `oab`, `classroom_type_name` |
| `plataforma1_espelho.user_on_classroom` | `user_id`, `classroom_id`, `status` |

**Portanto:** o `plataforma1_espelho` precisa existir nesse mesmo banco. Se a
infra preferir instâncias separadas, o cruzamento precisa ser reescrito
(`postgres_fdw`, réplica lógica, ou buscar compradores via rede no Worker) —
isso é reengenharia, não configuração.

## 3. O usuário do banco

O ideal é um usuário que só leia o espelho e seja dono do `leadscore` — assim
um bug jamais escreve no espelho.

```sql
CREATE USER leadscore_app WITH PASSWORD '<senha forte>';

-- dono do próprio schema
CREATE SCHEMA leadscore AUTHORIZATION leadscore_app;

-- leitura, e só leitura, do espelho
GRANT USAGE ON SCHEMA plataforma1_espelho TO leadscore_app;
GRANT SELECT ON ALL TABLES IN SCHEMA plataforma1_espelho TO leadscore_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA plataforma1_espelho
  GRANT SELECT ON TABLES TO leadscore_app;
```

## 4. Rede — o Worker vem de fora da VPC

O Cloudflare Worker não roda na AWS. Ele sai de IPs da Cloudflare, que **mudam**,
então não dá para liberar um IP fixo no security group. Três caminhos, do mais
limpo ao mais frouxo:

1. **Cloudflare Tunnel** (`cloudflared` num container/EC2 dentro da VPC). O RDS
   continua privado; nada exposto na internet. É o caminho recomendado.
2. **Hyperdrive** da Cloudflare — dá pooling e cache na borda (existe no plano
   Free), mas ainda exige que o RDS seja alcançável pela Cloudflare.
3. **RDS público + security group com as faixas da Cloudflare.** Funciona, é o
   mais rápido de montar, e é o mais exposto. Se for esse, exigir TLS.

## 5. TLS

Hoje a connection string do projeto usa `sslmode=disable`, herdado do padrão
interno do painel de aprovados. Saindo de um Worker pela internet, isso é
usuário e senha em texto puro. RDS suporta TLS de fábrica: **use
`?sslmode=require`** na `DATABASE_URL`.

O `worker/src/db.ts` já liga TLS automaticamente quando detecta `sslmode` na URL
(com `rejectUnauthorized: false`, então não é preciso embarcar o CA da Amazon).

## 6. O que devolver para quem for fazer o deploy

Uma única linha:

```
postgres://leadscore_app:<senha>@<endpoint>.sa-east-1.rds.amazonaws.com:5432/postgres?sslmode=require
```

Com ela, o resto é local:

```bash
npm run db:check      # conecta? lê o espelho? cria schema? aceita TLS?
npm run db:migrate    # cria o schema leadscore
```
