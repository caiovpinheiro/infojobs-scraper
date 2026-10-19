# Painel Pandapé → Bwipo CRM

Aplicativo Node.js com página e API na **mesma origem**, para subir a partir do GitHub no Easypanel. Não usa Discord, webhook de ativação, n8n, Meta ou WhatsApp. O `.env` pertence ao servidor; o navegador nunca recebe o cookie do Pandapé nem a chave do CRM.

## Operação

1. Entre com o usuário e a senha de `APP_USER` e `APP_PASSWORD` e clique **Buscar inscritos**.
2. O servidor lista as vagas do Pandapé, lê a aba **Inscritos**, conta todos os inscritos encontrados e carrega até `MAX_CANDIDATES` pessoas com nome, telefone, CEP, vaga, ID e tipo. Esta etapa **não escreve** em nenhum serviço.
3. Se o tipo da vaga não estiver configurado em `VACANCY_TYPES_JSON`, o operador pode marcar CLT ou estágio na tabela das vagas. Essa classificação vale somente para a consulta corrente.
4. Filtre o tipo, marque pessoas individualmente ou indique uma quantidade para selecionar as primeiras pessoas do tipo escolhido. Confirme a criação.
5. O servidor reconfirma que cada pessoa ainda está em **Inscritos**. Busca o contato por telefone no Bwipo CRM, cria se não existir e pula quem já tem negócio; caso contrário cria negócio na etapa configurada, nota com os dados disponíveis da vaga/candidato e tag, se configurada. Mostra os resultados por pessoa.

**Não move candidato no Pandapé nem envia WhatsApp.** A quantidade é o número de pessoas selecionadas para tentar criar no CRM; o total criado pode ser menor por falta de telefone, duplicidade, mudança da fila ou erro.

## Instalação

1. Suba apenas os arquivos desta pasta em um repositório **privado** no GitHub. Não suba o JSON original do n8n nem `.env`.
2. No Easypanel, crie um serviço a partir do repositório com este `Dockerfile`, porta **3000**, domínio HTTPS e **uma instância**.
3. Configure no serviço as variáveis de `.env.example`. `PANDAPE_LOGIN_URL` aponta para a aplicação `pandape-login` acessível pela rede; `PANDAPE_LOGIN_TOKEN` recebe o mesmo valor de `AUTH_TOKEN` configurado nela. Use a chave do CRM para a organização correta e a etapa de destino desejada. `CRM_TAG_ID` é opcional.
4. Inicie o serviço. `/health` responde `{ "ok": true }`. Acesse o domínio e teste primeiro a consulta, depois importe **uma pessoa** para conferir etapa, nota e tag no CRM antes de usar lotes grandes.

Você também pode testar localmente com Node 20+:

```bash
cp .env.example .env
# Edite .env com seus valores reais; nunca faça commit dele.
npm start
```

Abra `http://localhost:3000`. No Easypanel, informe as variáveis no painel do serviço; não é necessário criar arquivo `.env` no repositório.

## Configurações e limites

| Variável | Uso |
| --- | --- |
| `APP_USER`, `APP_PASSWORD` | Credenciais do operador, enviadas apenas à API da própria aplicação por HTTPS |
| `PANDAPE_LOGIN_URL`, `PANDAPE_LOGIN_TOKEN` | URL do serviço `pandape-login` e seu `AUTH_TOKEN`; o painel chama `GET /cookie` com o cabeçalho `X-Auth-Token` |
| `PANDAPE_LOGIN_DEPLOY_URL` | Opcional. Webhook de deploy do EasyPanel desse serviço, usado só quando a renovação do cookie falha |
| `PANDAPE_COOKIE` | Alternativa manual às duas variáveis acima; cookie completo da sessão autenticada |
| `CRM_BASE_URL`, `CRM_API_KEY` | API do Bwipo CRM e respectiva chave |
| `CRM_STAGE_ID` | Etapa na qual novos negócios serão criados |
| `CRM_TAG_ID` | Tag opcional aplicada a novos negócios |
| `VACANCY_TYPES_JSON` | Mapa opcional por ID Pandapé, como `{"12345":"CLT","67890":"ESTAGIO"}` |
| `MAX_VACANCIES`, `MAX_CANDIDATES`, `MAX_IMPORT` | Tetos de leitura e tamanho do lote; padrões 100, 500 e 100 |

O export do workflow comprova somente **nome/ID da vaga, nome/ID da pessoa, telefone e CEP** nos endpoints usados. Não assumi salário, modalidade, e-mail ou descrição, pois o HTML do Pandapé não foi fornecido. O tipo CLT/estágio não aparece no código original; por isso é configurado por ID ou escolhido pelo operador. Se você fornecer um exemplo da resposta de detalhes da vaga, podemos extrair automaticamente os demais campos disponíveis.

### Serviço `pandape-login`

O Dockerfile fornecido inicia um serviço Playwright que faz login no Pandapé e, se houver verificação em duas etapas, busca o código no Titan. Ele guarda em memória o cookie `ats-webui` com a validade e o devolve em `GET /cookie`. Essa rota exige `X-Auth-Token`; `GET /health` é público. O painel consulta o serviço no servidor e reutiliza o cookie enquanto `expiresAt` estiver no futuro (com margem de um minuto). Quando o prazo passa, pede `GET /cookie` de novo. Se a resposta vier vencida, chama `/cookie?force=1` uma vez. Se ainda assim a sessão não servir, e `PANDAPE_LOGIN_DEPLOY_URL` estiver definida, dispara esse webhook de deploy, espera `/health` cair e voltar, e então lê o cookie novo. A primeira consulta pode demorar enquanto o serviço autentica ou reinicia.

Deixe `PANDAPE_EMAIL`, `PANDAPE_PASSWORD`, `TITAN_EMAIL`, `TITAN_PASSWORD` e `AUTH_TOKEN` **somente no serviço `pandape-login`**. No painel configure a URL e o token correspondente, sem copiar as senhas nem colocar segredos no HTML ou no GitHub. O workflow n8n fornecido tinha um nó `Cookie Pandapé` com valor fixo; não havia nele chamada a esse serviço.

## Correspondência com o workflow antigo

| Etapa antiga | Neste aplicativo |
| --- | --- |
| Discord: assinatura, PING, comandos e resumo | Removidos; acesso por página autenticada |
| `Cookie Pandapé`, `ListVacancies`, `Matches`, `ListMatches` | Leitura no servidor; o cookie é obtido do `pandape-login` quando configurado |
| `MoveToFolder` | Removido; consultar/importar não move a pessoa |
| Envio WhatsApp e checagem em 2h | Removidos nesta versão |
| `/infojobs-teste`: contato, negócio, nota e tag | Adaptado para seleção explícita na página, com busca de duplicatas |

## Limites operacionais

- O Pandapé é lido por endpoints e HTML internos observados no workflow. Se o formato da plataforma mudar, os seletores do `server.js` terão de ser ajustados. Se o `pandape-login` não conseguir autenticar ou a alternativa manual vencer, a consulta falha.
- O estado da prévia e dos lotes fica **em memória por instância**. Reiniciar o serviço durante um lote perde o acompanhamento na página; confira o CRM antes de repetir. Para produção com vários operadores ou instâncias, migre esse estado e a idempotência para PostgreSQL/Supabase.
- A prévia vale por 15 minutos. As vagas consultadas são limitadas por `MAX_VACANCIES`, e a tabela por `MAX_CANDIDATES`. Se houver mais inscritos que linhas, a interface mostra os dois números separadamente.
- A verificação de duplicidade segue o comando `/infojobs-teste`: **qualquer negócio** encontrado para o contato faz a pessoa ser pulada. Podemos mudar isso para verificar apenas negócio aberto quando você definir a regra desejada.
- O JSON original do n8n contém cookie do Pandapé, chave do CRM, token da Meta e webhook do Discord embutidos. Renove esses segredos antes de reutilizá-los e mantenha-os fora do repositório.
