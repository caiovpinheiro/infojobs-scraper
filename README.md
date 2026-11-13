# Painel Pandapé → Bwipo CRM

Aplicativo Node.js com página e API na **mesma origem**, para subir a partir do GitHub no Easypanel. Não usa Discord, webhook de ativação, n8n, Meta ou WhatsApp. O `.env` pertence ao servidor; o navegador nunca recebe o cookie do Pandapé nem a chave do CRM.

## Operação

1. Escolha o tipo de vaga (todos, CLT ou estágio) e a quantidade de vagas, e clique **Buscar vagas**. O painel não tem login (veja "Acesso" abaixo).
2. O servidor lista as vagas do Pandapé, lê a aba **Inscritos**, conta todos os inscritos encontrados e carrega até `MAX_CANDIDATES` pessoas com nome, telefone, CEP, vaga, ID e tipo. Esta etapa **não escreve** em nenhum serviço.
3. Se o tipo da vaga não estiver configurado em `VACANCY_TYPES_JSON`, o operador pode marcar CLT ou estágio na tabela das vagas. Essa classificação vale somente para a consulta corrente.
4. Filtre o tipo, marque pessoas individualmente ou indique uma quantidade para selecionar as primeiras pessoas do tipo escolhido. Confirme a criação.
5. O servidor reconfirma que cada pessoa ainda está em **Inscritos**. Busca o contato por telefone no Bwipo CRM, cria se não existir e pula quem já tem negócio; caso contrário cria negócio na etapa configurada, nota com os dados disponíveis da vaga/candidato e tag, se configurada. Mostra os resultados por pessoa.

**Não move candidato no Pandapé nem envia WhatsApp.** A quantidade é o número de pessoas selecionadas para tentar criar no CRM; o total criado pode ser menor por falta de telefone, duplicidade, mudança da fila ou erro.

## Agente de triagem (seção 2)

Com **Analisar os inscritos com o agente depois da busca** marcado (padrão), o clique em **Buscar vagas** já faz tudo: liga cada vaga do Pandapé à vaga aberta do sistema da DNA, roda o agente e mostra o resumo com **Baixar planilha (.xlsx)**. As ligações ficam em "Ver ou ajustar as ligações das vagas" e só precisam de atenção quando alguma vaga não foi ligada ou foi ligada errado; aí é ajustar e clicar em **Rodar agente de novo**. A ligação automática entende abreviações (RH, Adm., Aux., Op.), o feminino (operadora, vendedora) e estagiário/estágio.

A seção **2. Analisar com o agente** cruza as vagas do Pandapé com as vagas abertas do sistema da DNA e ranqueia os inscritos de cada vaga. **Só leitura**: não move, não favorita, não manda mensagem no Pandapé, não cria nada no CRM e não grava no banco.

1. O painel lê as vagas abertas de `public.vaga` (com `public.empresa`, `public.cargo` e `dna_work.flex`) no `DATABASE_URL`. `tipo_vaga` 1 = Estágio, 2 = CLT.
2. Para cada vaga do Pandapé, liga sozinho a vaga do sistema da DNA mais parecida (mesmo tipo, cargo parecido). Vaga sem correspondência fica fora e aparece no Resumo.
3. A análise:
   - distância em linha reta do CEP do inscrito até a vaga (AwesomeAPI e, se falhar, BrasilAPI). Mais de **8 km** é descartado antes da IA. Sem CEP localizável fica fora e conta como "sem distância";
   - idade: vale a da vaga no banco; CLT sem idade na vaga usa 18;
   - a IA (Luna, OpenAI Responses API, `store: false`) lê os requisitos da vaga uma vez e o currículo de cada inscrito. Do perfil do Pandapé vai **só o trecho do currículo** (resumo, experiências, formação, competências, idiomas), sem nome, telefone, e-mail, endereço, CEP nem nome do arquivo do CV;
   - descartes: CLT sem experiência na função ou em função relacionada (mapa de funções no prompt, `agente/prompts.js`); estágio sem matrícula ativa, formado ou com ensino médio/técnico quando a vaga não aceita;
   - nota de 0 a 10: obrigatórios até 5, experiência 3 (mesma função) ou 2 (relacionada), distância 1 (até 3 km) ou 0,5 (3 a 8 km), desejáveis até 1. Vaga sem desejáveis dá o ponto inteiro. Empate: quem tem 6+ meses na área, depois o mais perto.
4. **Baixar planilha (.xlsx)**: aba Resumo (inscritos analisados, sem distância, descartados, aderentes, meta de 50 e observações) e uma aba por vaga, com cabeçalho da vaga, colunas pedidas, filtro, cabeçalho fixo, nota ≥ 8 em verde e de 5 a 7,9 em amarelo.

Limites: o agente avalia os inscritos que a busca trouxe (respeita `MAX_CANDIDATES` e deixa de fora quem já foi disparado para o CRM). Um agente por vez; o resultado fica 1 hora na memória da instância. A busca na base inteira do Pandapé por CEP e raio ainda não existe.

Arquivos: `agente/texto.js` (recorte do perfil, horário, sugestão de ligação), `agente/regras.js` (8 km, descartes, nota, ordem), `agente/geo.js`, `agente/ia.js`, `agente/prompts.js`, `agente/vagas.js`, `agente/job.js`, `agente/planilha.js`, `agente/servico.js` (rotas `/api/agente*`).

## Acesso

O painel **não tem login**. Quem tiver o endereço vê nome, telefone e CEP dos inscritos e pode criar negócios no CRM. Não divulgue o domínio; se precisar restringir, use a proteção por senha do próprio Easypanel ou uma lista de IPs no proxy.

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
| `PANDAPE_LOGIN_URL`, `PANDAPE_LOGIN_TOKEN` | URL do serviço `pandape-login` e seu `AUTH_TOKEN`; o painel chama `GET /cookie` com o cabeçalho `X-Auth-Token` |
| `PANDAPE_LOGIN_DEPLOY_URL` | Opcional. Webhook de deploy do EasyPanel desse serviço, usado só quando a renovação do cookie falha |
| `PANDAPE_COOKIE` | Alternativa manual às duas variáveis acima; cookie completo da sessão autenticada |
| `CRM_BASE_URL`, `CRM_API_KEY` | API do Bwipo CRM e respectiva chave |
| `CRM_STAGE_ID` | Etapa na qual novos negócios serão criados |
| `CRM_TAG_ID` | Tag opcional aplicada a novos negócios |
| `LEAD_WEBHOOK_URL` | Webhook de origem do sistema interno (`https://interno.dnawork.ai/api/v1/webhooks/lead-criado`), chamada a cada negócio novo com `{"telefone":"+55…","origem":"infojobs","campanha":"<vaga>","contactId":…,"dealId":…}`. Vazia ou ausente desliga o envio. 5xx ou falha de rede tenta mais duas vezes; 404 (telefone não encontrado no CRM) não repete. Falha nela não impede a criação no CRM |
| `VACANCY_TYPES_JSON` | Mapa opcional por ID Pandapé, como `{"12345":"CLT","67890":"ESTAGIO"}` |
| `DATABASE_URL` | Postgres do sistema da DNA. Guarda as ativações e é de onde o agente lê as vagas abertas |
| `OPENAI_API_KEY` | Chave da OpenAI para o agente. Sem ela, a seção 2 mostra "Agente indisponível" e o resto funciona |
| `OPENAI_API_URL`, `LUNA_MODEL`, `LUNA_TIMEOUT_MS` | Opcionais. Padrões `https://api.openai.com/v1`, `gpt-6-luna` e 60000 ms |
| `MAX_VACANCIES`, `MAX_CANDIDATES`, `MAX_IMPORT` | Tetos de leitura e tamanho do lote; padrões 100, 500 e 100. A página aceita de 1 a 2000 vagas |

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
- A verificação de duplicidade pula quem já tem negócio no pipeline Candidaturas, em qualquer etapa, inclusive perdido. Um negócio perdido também conta mesmo que a lista padrão do CRM não o devolva. Negócio aberto em outro pipeline não impede a criação.
- O JSON original do n8n contém cookie do Pandapé, chave do CRM, token da Meta e webhook do Discord embutidos. Renove esses segredos antes de reutilizá-los e mantenha-os fora do repositório.
