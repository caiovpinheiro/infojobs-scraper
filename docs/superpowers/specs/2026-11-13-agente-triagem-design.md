# Agente de triagem depois do scraper — design

> 2026-11-13 · Repositório: `infojobs-scraper` (painel Pandapé → Bwipo CRM)

## Por que

Hoje o painel lista as vagas do Pandapé e os inscritos nelas, e o operador escolhe à mão quem vai para o CRM. A DNA Work quer que, depois dessa busca, um agente com IA (GPT, chamado de "Luna") cruze cada vaga do Pandapé com a vaga correspondente do sistema da DNA (Postgres do `DATABASE_URL`), avalie os inscritos pelos requisitos reais da vaga e entregue uma lista ranqueada, pronta para triagem, em Excel. O painel também fica mais simples: sem usuário e senha, só um botão de buscar vagas com quantidade e tipo.

## Objetivos

1. **Tela sem login**: some o formulário de usuário/senha e a autenticação Basic do servidor. A tela começa com "Tipo (Todos/CLT/Estágio)", "Quantidade de vagas" e o botão **Buscar vagas**.
2. **Ligação de vagas**: depois da busca, cada vaga do Pandapé ganha uma vaga do sistema da DNA sugerida, que o operador confirma ou troca numa lista.
3. **Agente**: para cada vaga ligada, avalia os inscritos daquela vaga do Pandapé, descarta quem não serve, dá nota de 0 a 10 e ordena.
4. **Entrega**: planilha `.xlsx` para download, no formato pedido (ver "Planilha").

## Fora do escopo (agora)

- **Busca na base inteira do Pandapé (Catho/InfoJobs) por CEP e raio.** Fica para uma segunda etapa. Depende de o operador mandar um `.har` ou o HTML de uma busca feita no Chrome, porque o endereço e o formato dessa tela não são conhecidos. O desenho do agente (seção "Agente") deve servir para essa etapa sem mudança: só muda de onde vêm os candidatos.
- Mudar a lógica do scraper (`findVacancyIds`, `createPreview`, `listMatches`, `extractDetail`) ou da importação para o CRM (`importCandidates`). Continuam como estão.

## Antiobjetivos (seria um fracasso mesmo funcionando)

- O agente **escrever** em qualquer lugar: nada de mover pasta, favoritar ou mandar mensagem no Pandapé, nada de criar contato/negócio no CRM, nada de `INSERT/UPDATE` no Postgres. Só leitura. A importação para o CRM continua sendo um passo separado e manual.
- Aumentar o raio além de 8 km, mudar idade ou afrouxar requisito por conta própria. O raio é constante no código (8), não variável de ambiente.
- Inventar dado: o que não estiver no perfil vira "não identificado".
- Passar candidato CLT sem experiência relacionada, ou candidato a mais de 8 km.

## Decisões já tomadas com o operador

- **Sem login** (opção "c"). O operador foi avisado de que, sem proteção, quem tiver o link vê nome, telefone e CEP dos candidatos e pode criar negócios no CRM, e escolheu assim. Remover `APP_USER`/`APP_PASSWORD` do código, da checagem de boot, do README e do `.env.example`.
- **Abordagem A — regras no código, IA só para ler texto** (ver "Abordagens").
- O agente roda **dentro do painel** (mesmo `server.js` + módulo novo), não no n8n.

## Abordagens consideradas

| | Como | Prós | Contras | Escolha |
|---|---|---|---|---|
| **A** | Código faz distância, idade, corte de 8 km e a conta da nota. A IA lê o perfil e responde só o que exige interpretação (experiência mesma/relacionada/sem relação, meses, matrícula, curso/semestre/turno, requisitos atendidos). | Nota estável, 8 km garantido, barato. | Mapa de cargos e pesos ficam no prompt e no código. | **Escolhida** |
| B | O prompt inteiro + vaga + perfil vão para a IA, que devolve a nota. | Simples de ajustar. | Nota varia, IA pode errar distância, mais caro. | — |
| C | IA ranqueia 20 perfis por chamada. | Mais barato. | Perde detalhe por candidato. | — |
| (n8n) | Fluxo separado no n8n. | — | Teria de buscar de novo o que o painel já tem em memória e o cookie do Pandapé. | — |

## Fluxo na tela

```
1. Buscar vagas      [Tipo: Todos ▾] [Quantidade de vagas: 20] [Buscar vagas]
2. Vagas encontradas (tabela atual, sem mudança)
3. Escolher candidatos → importar no CRM (sem mudança)
4. Analisar com o agente
   Vaga Pandapé            | Tipo | Inscritos | Vaga no sistema da DNA            
   Operador de Caixa (123) | CLT  | 42        | [Operador de Caixa – Loja X, Mooca ▾]
   Estágio em RH (456)     | Est. | 18        | [— não ligar — ▾]
   [Rodar agente]   barra de progresso "37 de 60 perfis avaliados"
   Resultado: tabela-resumo por vaga + [Baixar planilha (.xlsx)]
```

A aba "Ativações" continua igual.

## Vagas do sistema da DNA (leitura)

Fonte: `DATABASE_URL` (o mesmo Postgres `dnaworkia` já usado para `ativacoes`). Segundo o sistema da DNA, `public.vaga` só guarda vagas **abertas** (o sync tira as fechadas), então não há filtro de status.

Consulta (só leitura), com nomes conferidos na documentação do `sistema-dna-v1` (`docs/agentes/triagem/agente.md`):

- `public.vaga v`: `id`, `vaga_id` (código), `tipo_vaga` (**1 = Estágio, 2 = CLT**), `cargo`, `salario`, `beneficios`, `sexo`, `idade`, `idade_ate`, `horario`, `carga_horaria`, `escolaridade` (código), `atividades`, `descricao`, `requisitos`, `cep`, `latitude`, `longitude`, `empresa_id`.
- `LEFT JOIN public.empresa e ON e.id = v.empresa_id`: `nome_fantasia`, `local` (bairro/cidade), `logradouro`, `numero`, `cep`.
- `LEFT JOIN dna_work.flex f ON f.id_flex = v.escolaridade`: `valor` = escolaridade por extenso.
- O `sistema-dna-v1` tem consulta "básica" para quando faltam `descricao`/`requisitos` ou `dna_work.flex` (erros `42703`/`42P01`). Fazer o mesmo: se a consulta completa falhar com esses códigos, cair para uma consulta só com as colunas certas.
- `horario` pode vir como `texto=…` (usar o texto) ou `1=HH:MM-HH:MM;2=…` (1 = domingo … 7 = sábado). Mandar para a IA convertido em texto legível.
- Vaga sem `latitude/longitude`: tentar geocodificar o `cep` da vaga (mesma rotina dos candidatos). Sem ponto, a vaga aparece no Resumo como **"CEP pendente"** e não é avaliada.

Empresa/loja aparece só na planilha interna e na tela; nunca é mandada para fora além da OpenAI (que recebe a vaga para avaliar).

## Ligação vaga Pandapé ↔ vaga DNA

Não existe código comum conhecido entre os dois sistemas.

- Sugestão automática: mesmo tipo (CLT/Estágio) e maior semelhança entre o título do Pandapé e o `cargo` da vaga DNA (palavras normalizadas, sem acento/caixa/stopwords; desempate por palavras do título que batem com `local`/`nome_fantasia`). Abaixo de um mínimo de semelhança, a sugestão fica "— não ligar —".
- O operador confirma ou troca em um `<select>` com todas as vagas DNA do mesmo tipo (rótulo: `cargo – nome_fantasia, local (vaga_id)`).
- Vaga do Pandapé sem ligação não é avaliada; vai ao Resumo como "sem vaga correspondente".
- Uma mesma vaga DNA pode ser ligada a mais de uma vaga do Pandapé; nesse caso os inscritos das duas entram juntos naquela aba, sem repetir pessoa.
- Vaga do Pandapé com tipo desconhecido usa o tipo da vaga DNA escolhida.

## Candidatos

Os candidatos são os do snapshot da busca (`snapshots`, em memória, vale 15 minutos). Ao clicar **Rodar agente**, o servidor copia os candidatos das vagas ligadas para o job do agente, para não depender da expiração do snapshot.

Observação: o snapshot já exclui quem foi "disparado" para o CRM antes (`alreadyDispatched`). Isso continua: o agente avalia só os inscritos novos que a busca trouxe.

- **Perfil completo**: o scraper já abre `/Company/Match/Matches/{idVacancy}?idvacancyfolder={folderId}&idMatch={idMatch}` e extrai poucos campos. O agente faz de novo esse `GET` (só leitura, pelo mesmo `pandapeGet`, concorrência 5). **Conferido num `.har` real (2026-11-13)**: a página traz o currículo em blocos com ids fixos, nesta ordem: `ResumeProfile` (perfil e objetivos/resumo), `ResumeExperiences` (cada experiência com "Mmm AAAA - Mmm AAAA", "(N anos e M meses)", cargo, empresa e descrição), `ResumeDeficiencies`, `ResumeStudies` (formação, com "Cursando"/"Concluído", curso e instituição), `ResumeCertifications`, `ResumeSkills`, `ResumeLanguages`, `ResumeAdditionalInformation`, e depois `ResumePersonalInformationContainer` / `ResumeContactData` (dados pessoais e de contato).
  - O texto mandado à IA é **só o trecho de `id="ResumeProfile"` até `id="ResumePersonalInformationContainer"`** (exclusive), sem `script/style/tags`, com espaços normalizados, cortado em ~12.000 caracteres. Assim nome, telefone, e-mail e endereço do cabeçalho e de "Dados pessoais" não vão para a OpenAI.
  - Rede de segurança: remover do trecho e-mails, telefones (8+ dígitos com ou sem `+55`, traços, parênteses), CEPs e linhas com nome de arquivo (`*.pdf`, `*.doc*` — o "CV em anexo" usa o nome da pessoa no arquivo).
  - Se o trecho não for encontrado (formato mudou), o candidato fica com status "perfil ilegível", não é avaliado e conta no Resumo.
  - A página **não mostra data de última atualização do currículo** (só a data da candidatura, "Hoje às 13:02h via Indeed"). A sinalização "perfil desatualizado" fica fora; o campo `perfil_atualizado_em` sai do schema.
  - A página mostra a "Adequação CV N %" do próprio Pandapé; não é usada na nota.
  - O `.har` usado contém dados pessoais e cookie de sessão: **não entra no repositório**. Fixtures de teste são HTML sintético com a mesma estrutura de ids.
- **Distância**: CEP do candidato (já extraído pelo scraper) → coordenada por **AwesomeAPI** (`https://cep.awesomeapi.com.br/json/{cep}`, campos `lat`/`lng`) e, se falhar, **BrasilAPI** (`https://brasilapi.com.br/api/cep/v2/{cep}`, `location.coordinates`). Cache em memória por CEP. Distância em linha reta (haversine) até a vaga. Mesmo CEP da vaga = 0 km.
  - Sem CEP ou CEP não localizado: não entra na lista ranqueada (não dá para garantir os 8 km). Conta no Resumo como "sem distância".
  - Distância > 8 km: descartado **antes** de chamar a IA (economiza chamadas).
- **Idade**: o scraper já calcula `idade`. Sem idade → "não identificado" (não descarta, mas o requisito de idade conta como não atendido).

## Agente (IA)

### Configuração
- `OPENAI_API_KEY` (obrigatória para o agente; sem ela, a seção 4 mostra "Agente indisponível: configure OPENAI_API_KEY" e o resto do painel funciona).
- `OPENAI_API_URL` (padrão `https://api.openai.com/v1`), `LUNA_MODEL` (obrigatória junto com a chave), `LUNA_TIMEOUT_MS` (padrão 60000). Mesmos nomes do `sistema-dna-v1`.
- OpenAI **Responses API** (`POST {OPENAI_API_URL}/responses`), `store: false`, saída estruturada por JSON Schema. Se o modelo recusar structured output (HTTP 400), repetir pedindo o JSON no texto (o `sistema-dna-v1` faz igual).
- Concorrência de chamadas: 4. Uma nova tentativa em erro 429/5xx/timeout; depois disso o candidato fica com status "falhou" e aparece nas observações.
- Nunca registrar em log o texto do perfil, nem a resposta da IA.

### Duas chamadas
1. **Uma por vaga DNA** — extrai os requisitos do texto da vaga (`requisitos`, `descricao`, `atividades`, escolaridade, idade, horário):
   `{ obrigatorios: [string], desejaveis: [string], idade_min: int|null, idade_max: int|null, aceita_medio_tecnico: bool|null, cursos: [string], semestre_min: int|null, turno_estudo_compativel: string|null, interpretacoes: [string] }`.
   Para CLT, idade mínima é a da vaga ou 18. Entra no cabeçalho da aba e em "interpretações" do Resumo.
2. **Uma por candidato (que passou no corte de 8 km)** — recebe a vaga estruturada + o texto do perfil e devolve:
   `{ experiencia: "mesma"|"relacionada"|"sem_relacao"|"nenhuma", experiencia_funcao: string|null, experiencia_meses: int|null, escolaridade: string|null, curso: string|null, semestre: string|null, matricula_ativa: bool|null, formado: bool|null, obrigatorios: [{requisito, situacao: "atendido"|"nao_atendido"|"nao_identificado"}], desejaveis: [mesmo formato], observacoes: string }`.

### Prompt
O texto do operador vira o prompt de sistema, adaptado para "você avalia UM perfil contra UMA vaga e responde só o JSON": papel (analista da DNA Work, vagas operacionais de varejo e estágio em SP), o **mapa de experiência relacionada** completo (Operador de Caixa, Repositor, Balconista de Frios/Açougue/Padaria, Operador/Auxiliar de Loja, Atendente/Vendedor, Administrativos, e "cargo fora do mapa: bom senso + explicar nas observações"), as regras de estágio (curso, semestre, instituição, turno compatível, matrícula ativa, formado não serve, médio/técnico só se a vaga aceitar, experiência é diferencial) e "dado ausente = não identificado; não invente". As partes de navegação (Chrome, Pandapé, ETAPA 1/3) ficam de fora porque o código faz isso. O prompt fica num arquivo próprio (`agente-prompts.js`) para ser editado sem mexer na lógica.

### Regras no código (decisivas)
Descartar (não entra na aba; conta no Resumo como "descartados" com o motivo):
- distância > 8 km;
- CLT: idade conhecida < idade mínima (vaga ou 18), ou > `idade_max` quando houver; experiência `sem_relacao` ou `nenhuma` ou não identificada;
- Estágio: `formado = true` ou `matricula_ativa = false`; idade fora da faixa da vaga quando conhecida; nível médio/técnico quando a vaga não aceita.

Nota (0 a 10, uma casa decimal):
- **Obrigatórios**: 5 × (atendidos ÷ total). "Não identificado" conta como não atendido. Vaga sem obrigatórios → 5.
- **Experiência**: mesma função 3; relacionada 2; nenhuma 0 (só possível em estágio).
- **Distância**: até 3 km 1; de 3 a 8 km 0,5.
- **Desejáveis**: 1 × (atendidos ÷ total). Vaga sem desejáveis → 1 *(decisão do builder/assistente; ver "Decisões do assistente")*.

Ordem: nota desc.; empate → quem tem 6+ meses na área primeiro; depois a menor distância.

Sinalizações nas observações: "também apto para: <cargo – loja>" quando a mesma pessoa (mesmo telefone; sem telefone, mesmo nome + nascimento) estiver aprovada em outra aba; o critério da IA quando o cargo não está no mapa.

Duplicidade: dentro de uma aba, a mesma pessoa aparece uma vez (fica a avaliação de maior nota).

Meta de 50: os inscritos de uma vaga podem ser menos que 50. O Resumo diz "Meta 50: não" e quantos foram encontrados. Nada de buscar fora dos inscritos nesta etapa.

## Planilha (.xlsx)

Biblioteca: `exceljs` (dependência nova). Nome do arquivo: `triagem-AAAA-MM-DD-HHmm.xlsx`.

- **Aba "Resumo"**: Vaga (cargo – loja), Tipo, CEP, Vaga(s) Pandapé ligada(s), Inscritos analisados, Sem distância, Descartados, Aderentes, Meta 50 (sim/não), Observações (interpretações de requisito, "CEP pendente", "sem vaga correspondente", falhas da IA, perfil sem experiência legível).
- **Uma aba por vaga DNA**: nome = cargo + bairro/loja, cortado em 31 caracteres, sem `[]:*?/\`, único (sufixo " 2", " 3" se repetir).
  - Cabeçalho (linhas 1 a ~7): ID da vaga, loja, cargo, tipo, CEP, requisitos obrigatórios, requisitos desejáveis.
  - Tabela logo abaixo, com colunas: Nº | Nome | Idade | Bairro/Cidade | Distância (km) | Experiência relacionada (função + tempo) | Escolaridade / Curso e semestre | Requisitos atendidos | Requisitos não atendidos | Nota (0–10) | Link do perfil no Pandapé | Observações.
  - Painel congelado na linha de títulos da tabela, filtro automático na tabela, nota ≥ 8 verde, de 5 a 7,9 amarelo.
  - Link do perfil: `https://pandape.infojobs.com.br/Company/Match/Matches/{idVacancy}?idvacancyfolder={folderId}&idMatch={idMatch}`.
  - Dado ausente: "não identificado".

## Servidor

- Módulo novo `agente.js` (vagas DNA, ligação, geocodificação, chamadas à IA, regras, nota) e `planilha.js` (montagem do xlsx). `server.js` ganha só as rotas e a remoção do login. `Dockerfile` passa a copiar os arquivos novos.
- Rotas novas (todas só leitura em sistemas externos):
  - `GET /api/agente/status` → `{ pronto, motivo }` (chave/modelo/banco configurados).
  - `GET /api/agente/vagas?snapshot=<id>` → vagas DNA abertas + sugestão de ligação para cada vaga do snapshot.
  - `POST /api/agente` `{ snapshotId, ligacoes: [{ idVacancy, vagaDnaId }] }` → 202 `{ jobId }`.
  - `GET /api/agente/<jobId>` → progresso, resumo e erros.
  - `GET /api/agente/<jobId>/planilha` → o `.xlsx`.
- Job em memória (como `jobs`/`previewJobs`), guardado por 1 hora. Um job por vez; um segundo pedido enquanto um roda responde 409.

## Testes

`node --test`, no estilo de `test/painel.test.js` (servidor real com Pandapé falso). URLs da OpenAI e dos geocodificadores configuráveis por variável para apontar para servidores falsos nos testes. Cobrir: tela sem login (rotas sem `Authorization` respondem), ligação sugerida, corte de 8 km antes da IA, descartes CLT/Estágio, conta da nota e ordem, duplicidade e "também apto para", planilha (abas, nomes, colunas, formatação condicional) e "agente indisponível" sem chave.

## Decisões do assistente (o operador pode mudar)

- Vaga sem requisitos desejáveis recebe o ponto inteiro de desejáveis (sem isso, nenhuma nota passaria de 9).
- "6+ meses" é o primeiro desempate, antes da distância.
- Candidato sem CEP localizável fica fora da lista e conta no Resumo.
- Sugestão de ligação por semelhança de cargo, sempre confirmada pelo operador.
- **Sexo da vaga** (`public.vaga.sexo`): ignorado pelo agente. O scraper não lê o sexo do candidato, e não entra como requisito para a IA.
- **Idade**: as colunas `idade`/`idade_ate` da vaga ganham; a idade extraída pela IA só preenche quando a coluna está vazia ou zero. CLT sem nenhuma das duas usa 18.
- **Meta 50** conta os **aderentes** (aprovados no filtro), não os inscritos. A aba lista todos os aderentes, sem corte em 50.
- O agente usa os candidatos do snapshot como estão: com o teto `MAX_CANDIDATES` e sem quem já foi disparado ao CRM. Quando o snapshot bateu no teto, o Resumo avisa que nem todos os inscritos foram analisados.

## Deixado para o builder

Nomes internos de funções, limiar da semelhança de títulos, layout exato da seção 4 (seguir o estilo atual do `index.html`), formato das mensagens de erro.
