# Pedido para a infra — banco do Lead Score

O painel Lead Score usa um Postgres. Este documento é o estado real do banco
hoje, o que precisa ser corrigido, e o que pedir ao provisionar o RDS.

## Situação atual (verificada em 01/09/2026)

O banco está **vivo e em uso**, atrás do ELB
`adf6bf1a3e13547689c2f8c223647464-984e0b66db785574.elb.sa-east-1.amazonaws.com`
(IPs públicos `56.126.74.248`, `56.126.51.149`, `54.207.154.195`).

O schema `leadscore` existe e as três migrations estão aplicadas. O
`plataforma1_espelho` está legível — 76.605 matrículas ativas com OAB, 28 turmas
entre OAB 45 e 48.

### Três problemas encontrados

**1. O banco aceita conexão da internet na 5432, sem TLS.**

Confirmado: conexão de fora da VPN, pela internet aberta, autentica normalmente.
E o servidor **recusa TLS** — `The server does not support SSL connections`.
Ou seja, usuário e senha de um banco de produção trafegam em texto puro pela
internet aberta, e a porta está exposta a qualquer origem.

Isto é anterior ao Lead Score e vale mais que ele: afeta todo mundo que usa
esse banco. É o item de maior prioridade deste documento.

**2. O hostname do ELB só resolve dentro da VPC.**

De fora, o nome não resolve; de dentro (resolver `172.31.0.2`), resolve nos três
IPs acima. Como o Cloudflare Worker roda fora da AWS, ele não consegue usar o
hostname — hoje o secret `DATABASE_URL` aponta para o **IP fixo**
`56.126.74.248`.

Isso é um paliativo: IP de ELB rotaciona, e quando rotacionar o painel cai.
Precisa de um nome que resolva publicamente, ou do endpoint de RDS (que resolve
no DNS público de fábrica).

**3. A VPN quebra o DNS de quem conecta.**

O servidor OpenVPN (`56.125.42.157:1194`) empurra `block-outside-dns` junto com
os resolvers `8.8.8.8` e `1.1.1.1`. Mas o túnel é split — só roteia
`172.31.0.0/16` — então esses resolvers não são alcançáveis por dentro do túnel,
e o `block-outside-dns` bloqueia todos os outros. Resultado: com a VPN
conectada, nenhum nome resolve e a máquina parece sem internet.

Correção no servidor: parar de empurrar `dhcp-option DNS` + `block-outside-dns`
num túnel split, **ou** subir um Route53 Resolver inbound endpoint dentro da
`172.31.0.0/16` e empurrar o IP dele. A segunda opção é melhor: além de
devolver o DNS, faz nomes privados da AWS resolverem para quem está na VPN.

## O que pedir ao provisionar o RDS

### 1. A instância

| Item | Valor | Porquê |
|---|---|---|
| Engine | PostgreSQL **13+** | `gen_random_uuid()` é nativo a partir do 13. |
| Região | `sa-east-1` | Latência com a borda da Cloudflare. |
| TLS | **obrigatório** | RDS traz de fábrica. Resolve o problema 1. |
| Endpoint | `*.rds.amazonaws.com` | Resolve no DNS público mesmo com instância privada. Resolve o problema 2. |

### 2. O espelho precisa ficar no mesmo banco

O schema `leadscore` **não é autossuficiente**. As funções de cruzamento fazem
JOIN direto com o `plataforma1_espelho`, no mesmo banco — é assim que os
compradores nunca ficam defasados (não existe cópia nem sincronismo).

Ver `db/migrations/002_funcoes.sql:71` e `db/migrations/003_multi_turma_e_modelos.sql:72`.

| Tabela | Colunas usadas |
|---|---|
| `plataforma1_espelho.user_` | `id`, `email`, `cellphone`, `role` |
| `plataforma1_espelho.classroom` | `id`, `oab`, `classroom_type_name` |
| `plataforma1_espelho.user_on_classroom` | `user_id`, `classroom_id`, `status` |

Se a infra preferir instâncias separadas, o cruzamento precisa ser reescrito
(`postgres_fdw`, réplica lógica, ou buscar compradores via rede no Worker) —
isso é reengenharia, não configuração.

### 3. O usuário do banco

Um usuário que só leia o espelho e seja dono do `leadscore` — assim um bug
jamais escreve no espelho.

```sql
CREATE USER leadscore_app WITH PASSWORD '<senha forte>';
CREATE SCHEMA leadscore AUTHORIZATION leadscore_app;
GRANT USAGE ON SCHEMA plataforma1_espelho TO leadscore_app;
GRANT SELECT ON ALL TABLES IN SCHEMA plataforma1_espelho TO leadscore_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA plataforma1_espelho
  GRANT SELECT ON TABLES TO leadscore_app;
```

### 4. Rede — o Worker vem de fora da VPC

O Cloudflare Worker não roda na AWS e sai de IPs da Cloudflare, que **mudam**.
Não dá para liberar um IP fixo no security group. Do mais limpo ao mais frouxo:

1. **Cloudflare Tunnel** (`cloudflared` na VPC). O RDS continua privado. Recomendado.
2. **Hyperdrive** — pooling e cache na borda, existe no plano Free, mas ainda
   exige o RDS alcançável pela Cloudflare.
3. **RDS público com TLS obrigatório e security group restrito.** É o que existe
   hoje, só que hoje sem o TLS e sem a restrição.

## Quando o endpoint estiver pronto

```bash
npm run db:check      # conecta? lê o espelho? cria schema? aceita TLS?
npm run db:migrate    # aplica db/migrations/*.sql
```

```bash
npm run db:url | npx wrangler secret put DATABASE_URL && npm run deploy
```
