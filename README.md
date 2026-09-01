# Lead Score — Vício & VDE

Cruza a **pesquisa de leads** (CSV das páginas de captura) com os **compradores**
(alunos matriculados na turma) para gerar um score 0–100 por lead e identificar o
padrão de comprador.

**Stack:** front React + Vite + Tailwind (design Vício) · API em Cloudflare Worker
(TypeScript) · dados no **RDS, schema `leadscore`** — o mesmo banco do painel de
aprovados.

O projeto **lê** o `plataforma1_espelho` e **escreve** só no `leadscore`. Como os
compradores saem do espelho na hora do cruzamento, nunca ficam defasados — não
existe sincronismo nem cópia de aluno em lugar nenhum.

## Fluxo

1. **Nova análise** — sobe o CSV; o painel lê as colunas, sugere o papel de cada uma
   (e-mail, telefone, pergunta…) e você confirma. Escolhe a turma (OAB × produto).
2. O CSV original vai comprimido pra `leadscore.dataset_arquivos` e as linhas
   normalizadas (e-mail em minúsculas; telefone pela regra do painel de aprovados,
   com as variantes de 9º dígito) vão pra `leadscore.leads`, em lotes.
3. **Cruzamento** — `ls_match_compradores` marca quem comprou: e-mail exato
   primeiro, telefone como fallback, lendo a turma direto do espelho.
4. **Lead Score** — para cada resposta: taxa de conversão, lift vs. taxa base e peso
   (log-verossimilhança com suavização de Laplace 5). Score do lead = soma dos pesos →
   percentil 0–100. Relevância da pergunta = V de Cramér. hot ≥ 80, warm 50–79, cold < 50.
5. **Calibração** — conversão real por decil de score.
6. **Leads** — lista pontuada com filtros e export CSV pro comercial.
7. **Bases** — o que já está no banco, com atalho pra reabrir análises antigas,
   rodar a mesma base contra outra turma e baixar o CSV original.

## Acurácia: duas alavancas

**1. Cruzar com todas as turmas da captação.** Um lançamento vende 40D, 60D, 90D,
150D e 180D. Marcar como comprador só quem entrou na 90D não apenas perde sinal —
coloca quem converteu em outro produto do lado dos não-compradores, invertendo o
sinal dessa gente. Na tela de turmas, marque **todos os produtos que aquela
captação vendeu**. Em teste controlado isso dobrou os compradores identificados.

**2. Combinar bases (tela Modelo).** Um lançamento sozinho dá poucas compras por
resposta. Empilhando edições (OAB 45 + 47), cada célula pergunta × resposta ganha
amostra. O peso de cada resposta é a **média ponderada do log-lift calculado
dentro de cada base**, cada uma medida contra a própria taxa base — somar
contagens cruas de lançamentos com conversões diferentes criaria sinal falso
(paradoxo de Simpson). Exige as mesmas perguntas nas bases.

Com 2+ bases o painel mede a acurácia **fora da amostra**: treina sem uma base e
pontua ela. AUC, lift dos hot e captura vêm desse modelo cego — o número
in-sample aparece do lado só para você ver o tamanho do otimismo.

## Rodar localmente

Duplo clique em **`start.bat`** (ou `.\start.bat` no terminal). Ele instala o que
faltar, sobe o Worker em `:8787` e o front em `:5175` e abre o navegador.
Para derrubar: **`parar.bat`**.

Antes da primeira vez, copie `.dev.vars.example` para `.dev.vars` e preencha a
`DATABASE_URL`.

```bash
npm install
npm run dev:api    # Worker  → http://localhost:8787
npm run dev        # painel  → http://localhost:5175
```

> Não precisa de Python. O `api/` em FastAPI ficou como referência histórica —
> a lógica foi portada para `worker/src` com paridade validada lead a lead.

## Subir do zero — roteiro de terminal

### 1. Conferir o banco

> Banco ainda não provisionado? `docs/INFRA-RDS.md` tem o pedido pronto para a
> infra: engine, permissões, rede e por que o `plataforma1_espelho` precisa
> estar no mesmo banco.

A credencial fica num lugar só. Os scripts leem, nesta ordem, `.env` → `.dev.vars`
→ `api/.env` (o antigo, com `DB_HOST`/`DB_USER`/`DB_PASSWORD`), e aceitam tanto
`DATABASE_URL` quanto as variáveis separadas. Se o `api/.env` já está preenchido,
não precisa fazer nada.

```bash
npm run db:check          # conecta? é réplica? lê o espelho? cria schema? aceita TLS?
```

Ele responde: conecta? é réplica (só leitura)? consegue ler o `plataforma1_espelho`?
consegue criar o schema? o banco aceita TLS? Se algum item vier em vermelho, resolva
antes de seguir — em geral é pedir pra infra:

```sql
CREATE SCHEMA leadscore AUTHORIZATION <seu_usuario>;
```

### 2. Criar as tabelas

```bash
npm run db:migrate:dry    # mostra o que seria aplicado
npm run db:migrate        # aplica db/migrations/*.sql
```

O runner controla o que já rodou em `leadscore.migrations` — pode rodar quantas
vezes quiser. Migrations são imutáveis: pra mudar algo, crie um `003_*.sql` novo.

### 3. Cloudflare

O Worker não lê `.env` — não é um processo Node. Em dev ele lê `.dev.vars`, em
produção lê os secrets da Cloudflare. Os dois saem da mesma credencial, sem
copiar senha na mão:

```bash
npm run db:dev-vars                                    # gera o .dev.vars (dev)

npx wrangler login
npm run db:url | npx wrangler secret put DATABASE_URL  # manda a mesma URL pro Cloudflare
npx wrangler secret put PAINEL_TOKEN                   # opcional: exige token pra abrir o painel

npm run deploy                                          # build do front + wrangler deploy
```

Sai no ar em `https://leadscore-vicio.<sua-conta>.workers.dev`.

### 4. (Opcional) Hyperdrive

Uma conexão por requisição funciona, mas cada uma paga o handshake até São Paulo.
O Hyperdrive faz pooling na borda e está disponível no plano Free:

```bash
npx wrangler hyperdrive create leadscore --connection-string "postgres://..."
# cole o id no bloco [[hyperdrive]] do wrangler.toml e rode npm run deploy
```

O código usa o binding automaticamente quando ele existe; a `DATABASE_URL` vira
o caminho de fallback.

## Segurança — o que olhar antes de produção

- **TLS.** Hoje a `DATABASE_URL` vai com `sslmode=disable`, que era o padrão do
  painel de aprovados dentro da rede. Do Worker, isso significa usuário e senha
  trafegando em texto puro pela internet. O `npm run db:check` testa se o banco
  aceita TLS; se aceitar, troque para `?sslmode=no-verify` (ou `require`) na
  `DATABASE_URL` do secret.
- **Exposição do banco.** O Worker sai de IPs da Cloudflare, que mudam. Se o
  security group do banco for restrito por IP, isso precisa ser tratado — o
  caminho limpo é Cloudflare Tunnel ou uma faixa liberada.
- **PAINEL_TOKEN.** Sem ele o painel fica aberto pra quem tiver a URL.
- **Permissão do usuário do banco.** O ideal é um usuário que só tenha `USAGE`
  no `plataforma1_espelho` e dono do `leadscore` — assim um bug nunca escreve
  no espelho.
- **Workers Paid ($5/mês) é recomendado.** No plano Free são 10 ms de CPU por
  requisição e o envio dos lotes de leads estoura isso. Ficando no Free, reduza
  o `TAMANHO_LOTE_BYTES` em `src/lib/api.js` para `32 * 1024`.

## Estrutura

```
worker/src/
  index.ts      # rotas da API + serve o front
  db.ts         # conexão Postgres (node-postgres sobre TCP; Hyperdrive opcional)
  etl.ts        # limpeza de e-mail/telefone (porte de api/etl.py)
  scoring.ts    # lift, peso, V de Cramér (porte de api/scoring.py)
db/
  migrations/001_schema.sql    # schema leadscore: datasets, leads, analises…
  migrations/002_funcoes.sql   # helpers de ETL em SQL + funções ls_*
  aplicar.mjs                  # runner de migrations
scripts/
  checar-rds.mjs   # diagnóstico de conexão/permissão/TLS
  env.mjs          # leitura de .env compartilhada
src/pages/
  UploadPage.jsx     # upload + mapeamento + progresso
  DatasetsPage.jsx   # bases que já estão no banco
  AnalysisPage.jsx   # impulsionadores, pesos, calibração
  LeadsPage.jsx      # lista pontuada + export
api/                 # FastAPI original (legado, não é mais usado)
```

## Notas

- As regras de normalização vivem em dois lugares — `worker/src/etl.ts` (para os
  leads do CSV) e `leadscore.limpar_email` / `leadscore.tel_chaves` (para os
  compradores do espelho). **Se mudar uma, mude a outra**: o match depende de as
  duas produzirem exatamente a mesma chave.
- Rodar uma análise nova sobre a mesma base **sobrescreve os scores dos leads**
  (o retrato da análise anterior fica salvo em `analises.stats`).
- O JSON de `analises.pesos` é o que alimenta o módulo do Optimiz.
- ~4% dos leads não respondem a pesquisa; "(não respondeu)" entra como resposta no
  modelo (também carrega sinal).
