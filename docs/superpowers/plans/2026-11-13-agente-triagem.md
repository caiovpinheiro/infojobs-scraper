# Agente de triagem — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Depois da busca de inscritos, ligar cada vaga do Pandapé a uma vaga aberta do sistema da DNA, avaliar os inscritos com a Luna (OpenAI) + regras no código e entregar um `.xlsx` ranqueado. Tirar o login da tela.

**Architecture:** Módulos CommonJS novos em `agente/` (funções puras separadas das que fazem I/O, com dependências injetadas para teste). `server.js` só ganha rotas e perde a autenticação. O agente roda como job em memória, igual a `previewJobs`/`jobs`.

**Tech Stack:** Node 22 (CommonJS, `node:test`), `pg` (já existe), `exceljs` (novo), OpenAI Responses API via `fetch`.

**Spec:** `docs/superpowers/specs/2026-11-13-agente-triagem-design.md`

## Global Constraints

- Raio fixo **8 km** (constante `RAIO_KM = 8`, não é variável de ambiente).
- Nada de escrita: o agente só faz `GET` no Pandapé, `SELECT` no Postgres e chamadas à OpenAI/geocodificadores.
- Variáveis: `OPENAI_API_KEY`, `OPENAI_API_URL` (padrão `https://api.openai.com/v1`), `LUNA_MODEL` (padrão `gpt-6-luna`, igual ao `sistema-dna-v1`), `LUNA_TIMEOUT_MS` (padrão 60000). Para teste: `GEO_AWESOME_URL` (padrão `https://cep.awesomeapi.com.br/json`), `GEO_BRASILAPI_URL` (padrão `https://brasilapi.com.br/api/cep/v2`).
- OpenAI: `store: false`; nunca logar texto de perfil nem resposta da IA.
- Texto à IA = trecho `id="ResumeProfile"` … antes de `id="ResumePersonalInformationContainer"`, redigido (e-mail, telefone, CEP, nome de arquivo).
- `tipo_vaga`: 1 = Estágio, 2 = CLT.
- Dado ausente na planilha: `"não identificado"`.
- Nota: obrigatórios 5×proporção (sem obrigatórios = 5); experiência mesma 3 / relacionada 2 / nenhuma 0; distância ≤3 km 1, ≤8 km 0,5; desejáveis 1×proporção (sem desejáveis = 1). Uma casa decimal.
- Ordem: nota desc → 6+ meses na área primeiro → menor distância.
- Planilha: abas ≤31 caracteres, sem `[]:*?/\`, únicas; congelar título da tabela; autofiltro; nota ≥8 verde, 5–7,9 amarelo.
- Sem login: remover `APP_USER`/`APP_PASSWORD` do código, da checagem de boot, README e `.env.example`.
- `.har` real não entra no repositório; fixtures sintéticas.

## Review Focus

1. Perfil sem o bloco `ResumeProfile` (formato mudou ou página de erro) → candidato "perfil ilegível", não quebra o job. Teste em Task 1.
2. CEP do candidato inválido/inexistente nos dois geocodificadores → fora da lista, conta "sem distância". Teste em Task 3.
3. IA devolve JSON inválido ou HTTP 400 para structured output → repete sem schema; erro final vira status "falhou" só daquele candidato. Teste em Task 4.
4. Nomes de aba repetidos/longos/com caracteres proibidos (ex.: "Op. Caixa / Loja [Mooca]") → aba válida e única. Teste em Task 6.
5. Banco sem `descricao`/`requisitos` (erro 42703) ou sem `dna_work.flex` (42P01) → consulta básica, sem falhar. Teste em Task 5.

---

### Task 1: Texto do perfil, horário e ligação de vagas (puro)

**Files:**
- Create: `agente/texto.js`
- Test: `test/agente-texto.test.js`

**Interfaces — Produces:**
- `normalizar(s: string): string` — minúsculas, sem acento, só `[a-z0-9 ]`, espaços simples.
- `perfilDoHtml(html: string): string | null` — trecho do CV redigido; `null` se não achar `id="ResumeProfile"`.
- `horarioTexto(horario: string|null): string|null` — `texto=…` ou grade `1=HH:MM-HH:MM;…` (1 = domingo … 7 = sábado) → "segunda a sexta, 08:00 às 17:00".
- `sugerirLigacoes(vagasPandape: {id,title,type}[], vagasDna: VagaDna[]): {[idVacancy]: string|null}` — id da vaga DNA (mesmo tipo, maior Jaccard de palavras do título vs `cargo`, desempate por palavras em `local`/`nome_fantasia`, mínimo 0,34) ou `null`.

- [ ] Step 1: testes — `perfilDoHtml` recebe HTML com cabeçalho contendo nome/`+55-11999998888`/`x@y.com`, blocos `ResumeProfile` → `ResumeExperiences` ("Auxiliar de Cobrança", "(7 meses)") → `ResumeStudies` ("Cursando") → "CV em anexo Fulano_Silva.pdf" → `ResumePersonalInformationContainer` com CEP; asserts: contém "Auxiliar de Cobrança", "7 meses", "Cursando"; não contém "x@y.com", "99999", "Fulano_Silva.pdf", "CEP". HTML sem `ResumeProfile` → `null`. `horarioTexto('2=08:00-17:00;3=08:00-17:00;4=08:00-17:00;5=08:00-17:00;6=08:00-17:00')` = `'segunda a sexta, 08:00 às 17:00'`; `horarioTexto('texto=12x36 noturno')` = `'12x36 noturno'`. `sugerirLigacoes([{id:'1',title:'Operador de Caixa - Mooca',type:'CLT'}], [{id:'a',cargo:'Operador de Caixa',tipo:'CLT',local:'Mooca'},{id:'b',cargo:'Repositor',tipo:'CLT'}])` = `{'1':'a'}`; título sem semelhança → `null`; tipo diferente nunca liga.
- [ ] Step 2: `node --test test/agente-texto.test.js` → FAIL (módulo não existe).
- [ ] Step 3: implementar. Redação: regex de e-mail; telefone `(\+?55[\s-]?)?\(?\d{2}\)?[\s-]?\d{4,5}[\s-]?\d{4}`; CEP `\b\d{5}-?\d{3}\b` e a palavra "CEP"; linhas terminando em `.pdf|.doc|.docx`. Cortar em 12000 caracteres. Reaproveitar `decodeEntities` exportado de `server.js`? Não: `server.js` exige env no boot; implementar decodificação local mínima (entidades nomeadas e numéricas).
- [ ] Step 4: testes passam.
- [ ] Step 5: commit "Agente: texto do perfil, horário e ligação de vagas."

### Task 2: Regras, nota e ordem (puro)

**Files:**
- Create: `agente/regras.js`
- Test: `test/agente-regras.test.js`

**Interfaces — Produces:**
- `RAIO_KM = 8`
- `distanciaKm(a:{lat,lng}, b:{lat,lng}): number` (haversine, raio 6371).
- `descarte({tipo, idadeMin, idadeMax, aceitaMedioTecnico}, candidato:{idade, distanciaKm}, aval: Avaliacao|null): string|null` — motivo ou `null`. `aval` null = só checa distância/idade (usado antes da IA).
- `nota(aval: Avaliacao, distanciaKm: number): number`
- `ordenar(lista: {nota, distanciaKm, aval}[]): lista` (nova array).
- `Avaliacao` = `{ experiencia: 'mesma'|'relacionada'|'sem_relacao'|'nenhuma', experiencia_funcao, experiencia_meses, escolaridade, curso, semestre, nivel: 'medio'|'tecnico'|'superior'|null, matricula_ativa, formado, obrigatorios:[{requisito,situacao}], desejaveis:[…], observacoes }`.

- [ ] Step 1: testes — `distanciaKm` SP Sé→Paulista ≈ 2,5–3,5; descarte: 9 km → "a mais de 8 km"; CLT idade 17 com idadeMin 18 → motivo; CLT `sem_relacao`/`nenhuma` → motivo; estágio `formado:true` → motivo; estágio `matricula_ativa:false` → motivo; estágio `nivel:'medio'` com `aceitaMedioTecnico:false` → motivo; idade `null` não descarta. `nota` com 2/4 obrigatórios, relacionada, 2 km, 0 desejáveis → 2,5+2+1+1 = 6,5; "nao_identificado" conta como não atendido; 5 km → +0,5. `ordenar`: [7 a 5km, 8 a 6km, 7 a 2km com 3 meses, 7 a 4km com 12 meses] → 8, 7(12m), 7(2km), 7(5km).
- [ ] Step 2: FAIL. Step 3: implementar. Step 4: PASS. Step 5: commit "Agente: regras de descarte, nota e ordem."

### Task 3: Geocodificação de CEP

**Files:**
- Create: `agente/geo.js`
- Test: `test/agente-geo.test.js`

**Interfaces — Produces:** `criarGeo({ fetch, awesomeUrl, brasilUrl }) → { pontoDoCep(cep: string): Promise<{lat,lng}|null> }` com cache por CEP (inclui `null`), timeout 10 s por chamada.

- [ ] Step 1: testes com `fetch` falso: AwesomeAPI `{lat:'-23.5',lng:'-46.6'}` → ponto; AwesomeAPI 404 e BrasilAPI `{location:{coordinates:{latitude:'-23.4',longitude:'-46.5'}}}` → ponto da BrasilAPI; ambos falham → `null`; segunda chamada do mesmo CEP não chama `fetch`; CEP com menos de 8 dígitos → `null` sem chamar.
- [ ] Step 2–5: FAIL → implementar → PASS → commit "Agente: geocodificação de CEP com cache."

### Task 4: Cliente da IA e prompts

**Files:**
- Create: `agente/prompts.js`, `agente/ia.js`
- Test: `test/agente-ia.test.js`

**Interfaces — Produces:**
- `prompts.js`: `PROMPT_REQUISITOS`, `PROMPT_AVALIACAO` (texto do operador adaptado: papel, mapa de experiência completo, regras de estágio, "não identificado", só JSON), `SCHEMA_REQUISITOS`, `SCHEMA_AVALIACAO` (JSON Schema strict; todos os campos `required`, nulos via `type: [..., 'null']`).
- `ia.js`: `criarIa({ fetch, url, key, model, timeoutMs }) → { pronta: boolean, requisitosDaVaga(vagaTexto: string): Promise<Requisitos>, avaliar(vagaTexto: string, req: Requisitos, perfil: string): Promise<Avaliacao> }`. `Requisitos` = `{ obrigatorios: string[], desejaveis: string[], idade_min, idade_max, aceita_medio_tecnico, interpretacoes: string[] }`.
- Corpo: `{ model, store:false, instructions, input:[{role:'user',content:[{type:'input_text',text}]}], text:{format:{type:'json_schema',name,strict:true,schema}} }`. Texto de saída: `output[].content[].type==='output_text'` concatenado, senão `output_text`.
- Erros: HTTP 400 com schema → repete sem `text.format`, pedindo "Responda só com JSON neste formato: <schema>"; 429/5xx/timeout → uma nova tentativa após 2 s; JSON inválido → erro `IA_FORMATO`.

- [ ] Step 1: testes com `fetch` falso: corpo enviado tem `store:false`, `model`, `Authorization: Bearer k`; resposta `output_text` é parseada; 400 → segunda chamada sem `text`; 500 depois 200 → sucesso; texto não-JSON → rejeita `/IA_FORMATO/`; `criarIa({key:''}).pronta === false`. Prompt de avaliação contém "Operador de Caixa", "Repositor", "Balconista", "Matrícula ativa", "não identificado".
- [ ] Step 2–5: FAIL → implementar → PASS → commit "Agente: cliente da Luna e prompts."

### Task 5: Vagas do sistema da DNA

**Files:**
- Create: `agente/vagas.js`
- Test: `test/agente-vagas.test.js`

**Interfaces — Produces:** `listarVagasDna(pool): Promise<VagaDna[]>`, `VagaDna` = `{ id, vagaId, tipo:'CLT'|'ESTAGIO', cargo, salario, beneficios, idade, idadeAte, horario (texto), cargaHoraria, escolaridade (texto ou null), atividades, descricao, requisitos, cep, lat, lng, empresa, local }`; `textoDaVaga(v: VagaDna): string` (o que vai à IA, sem empresa/CEP).
- Consulta completa: `public.vaga v LEFT JOIN public.empresa e ON e.id = v.empresa_id LEFT JOIN public.cargo c ON c.id = v.cargo_id` com `descricao/requisitos` caindo para os do cargo (`COALESCE(NULLIF(v.descricao,''), c.descricao)`), `WHERE v.tipo_vaga IN (1,2)`. Em 42703/42P01 → consulta básica (sem `descricao`, `requisitos`, `cargo`). Escolaridade: `SELECT id_flex::text, valor FROM dna_work.flex WHERE id_flex::text = ANY($1)`, erro → mapa vazio. `latitude/longitude` com `Number()`; inválido → `null`.

- [ ] Step 1: testes com `pool` falso (`query(sql, params)`): primeira consulta rejeita `{code:'42703'}` → usa a básica; tipo 1 → `'ESTAGIO'`; horário vira texto; escolaridade "3" → "Ensino Médio" via flex; flex com erro → `escolaridade:null`; `textoDaVaga` não contém `empresa` nem `cep`.
- [ ] Step 2–5: FAIL → implementar → PASS → commit "Agente: leitura das vagas abertas do sistema da DNA."

### Task 6: Planilha

**Files:**
- Create: `agente/planilha.js`
- Modify: `package.json` (dependência `exceljs`)
- Test: `test/agente-planilha.test.js`

**Interfaces:**
- Consumes: resultado do job (Task 7): `{ geradoEm: Date, resumo: LinhaResumo[], abas: { vaga: VagaDna, requisitos: Requisitos, ligadas: string[], candidatos: LinhaCandidato[] }[] }`.
- `LinhaResumo` = `{ vaga, tipo, cep, ligadas, analisados, semDistancia, descartados, aderentes, meta: boolean, observacoes }`.
- `LinhaCandidato` = `{ nome, idade, bairro, distanciaKm, experiencia, escolaridade, atendidos, naoAtendidos, nota, link, observacoes }` (strings já com "não identificado").
- Produces: `montarPlanilha(resultado): Promise<Buffer>`, `nomeDeAba(texto: string, usados: Set<string>): string`.
- Layout da aba: linhas 1–7 cabeçalho (ID da vaga, Loja, Cargo, Tipo, CEP, Obrigatórios, Desejáveis), linha 9 títulos, dados a partir da 10; `views: [{state:'frozen', ySplit: 9}]`; `autoFilter` A9:L(9+n); formatação condicional na coluna J: `>=8` verde `C6EFCE`, `between 5 e 7.9` amarelo `FFEB9C`; link como hyperlink.

- [ ] Step 1: testes — `nomeDeAba('Op. Caixa / Loja [Mooca]: Centro e mais coisas longas', usados)` tem ≤31 chars, sem `[]:*?/\`; repetido ganha " 2". `montarPlanilha` de um resultado com 1 vaga e 2 candidatos → ler de volta com `exceljs`: abas `['Resumo', <nome>]`, `A9` = "Nº", `L9` = "Observações", `J10` = nota, views congeladas em 9, `autoFilter` definido, 2 regras de formatação condicional, Resumo com "Meta 50" e "não".
- [ ] Step 2: `npm i exceljs@4.4.0` e FAIL. Step 3–5: implementar → PASS → commit "Agente: planilha xlsx."

### Task 7: Orquestração do job

**Files:**
- Create: `agente/job.js`
- Test: `test/agente-job.test.js`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `executarAgente({ ligacoes: {idVacancy, vagaDnaId}[], vagasPandape: {id,title,type}[], candidatos: Candidato[], vagasDna: VagaDna[], deps: { ia, geo, perfilHtml(c): Promise<string>, pandapeBase: string }, progresso(p:{feitos,total,fase}) }): Promise<Resultado>`; `Candidato` é o objeto do snapshot (`key, idMatch, idVacancy, folderId, nome, telefone, cep, endereco, nascimento, idade`).
- Passos: agrupar ligações por vaga DNA → para cada vaga: ponto da vaga (lat/lng ou `geo.pontoDoCep(cep)`; sem ponto → resumo "CEP pendente", pula) → `ia.requisitosDaVaga` (idade: colunas ganham; CLT sem nada = 18) → para cada candidato único (chave: telefone canônico, senão `nome|nascimento`): ponto do CEP (sem ponto → semDistancia), distância, `descarte(..., null)` → `perfilDoHtml(await perfilHtml(c))` (null → observação "perfil ilegível", conta descartado) → `ia.avaliar` (erro → "falhou") → `descarte(..., aval)` → `nota` → linha. Concorrência 4 nas chamadas à IA. Depois: "também apto para: <cargo – loja>" entre abas pela mesma chave; `ordenar`; `meta = aderentes >= 50`. Vagas Pandapé sem ligação → linha de resumo "sem vaga correspondente".
- Link: `${pandapeBase}/Company/Match/Matches/${idVacancy}?idvacancyfolder=${folderId}&idMatch=${idMatch}`.

- [ ] Step 1: testes com `ia`, `geo` e `perfilHtml` falsos: 4 candidatos numa vaga CLT — um a 9 km (IA não é chamada para ele), um `sem_relacao` (descartado), um sem CEP (semDistancia), um aprovado com nota calculada; mesma pessoa inscrita em duas vagas Pandapé ligadas à mesma vaga DNA aparece uma vez; mesma pessoa aprovada em duas vagas DNA recebe "também apto para"; IA rejeita para um candidato → observação "falhou" e o job termina; vaga DNA sem lat/lng e sem CEP → resumo "CEP pendente".
- [ ] Step 2–5: FAIL → implementar → PASS → commit "Agente: orquestração do job."

### Task 8: Servidor — sem login e rotas do agente

**Files:**
- Modify: `server.js` (config, checagem de boot `:144`, `authorized`/`attempts` `:1044-1080`, rotas, `module.exports`)
- Modify: `test/painel.test.js` (tirar `APP_USER/APP_PASSWORD`, `Authorization`)
- Modify: `Dockerfile` (`COPY server.js index.html ./` + `COPY agente ./agente`)
- Test: `test/agente-rotas.test.js`

**Interfaces — Produces (HTTP):**
- `GET /api/agente/status` → `{ pronto, motivo }` (motivo: "Configure OPENAI_API_KEY." ou "Configure DATABASE_URL." ou banco com erro).
- `GET /api/agente/vagas?snapshot=<uuid>` → `{ vagasDna: [{id, rotulo, tipo}], vagasPandape: [{id,title,type,total,sugestao}] }`; 404 snapshot inexistente/expirado.
- `POST /api/agente` `{ snapshotId, ligacoes }` → 202 `{ jobId }`; 409 se já há job rodando; 503 se não pronto; 400 sem ligações válidas. Mesma checagem de `Origin` das outras POST.
- `GET /api/agente/<uuid>` → `{ status:'running'|'completed'|'failed', feitos, total, fase, resumo?, error? }`.
- `GET /api/agente/<uuid>/planilha` → xlsx (`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename="triagem-AAAA-MM-DD-HHmm.xlsx"`); 404 se não terminou.
- Jobs guardados 1 hora; `perfilHtml` = `pandapeGet` do link do perfil; `geo` e `ia` criados a partir das variáveis.

- [ ] Step 1: testes (spawn do servidor como em `painel.test.js`, com Pandapé/OpenAI/geo falsos num servidor local e `DATABASE_URL` vazio + injeção de vagas de teste via `AGENTE_VAGAS_TESTE_JSON` lido só quando `NODE_ENV==='test'`): `/api/preview` responde 202 sem `Authorization`; boot sem `APP_USER` não sai com erro; `/api/agente/status` sem chave → `pronto:false`; fluxo preview → `/api/agente/vagas` → POST → poll → planilha com status 200 e assinatura ZIP `PK`; a fonte de `server.js` não contém `APP_PASSWORD`.
- [ ] Step 2: FAIL. Step 3: implementar; ajustar `painel.test.js`. Step 4: `npm test` → tudo PASS. Step 5: commit "Painel sem login e rotas do agente."

### Task 9: Tela

**Files:**
- Modify: `index.html`
- Test: `test/painel.test.js` (teste de conteúdo da página)

- [ ] Step 1: teste: HTML não contém `id="username"`, `id="password"`, `Basic `; contém "Buscar vagas", "Quantidade de vagas", "Analisar com o agente", "Baixar planilha".
- [ ] Step 2: FAIL. Step 3: card 1 vira "1. Buscar vagas" com Tipo + Quantidade de vagas + botão **Buscar vagas**; `api()` sem `Authorization`. Nova seção "4. Analisar com o agente" (aparece depois da busca): status do agente, tabela vaga Pandapé | tipo | inscritos | `<select>` com sugestão, botão **Rodar agente**, barra de progresso, tabela-resumo, botão **Baixar planilha**. Reaproveitar classes existentes (`card`, `table-wrap`, `progress`, `btn`, `pill`).
- [ ] Step 4: PASS; abrir no Chromium (Playwright) com o servidor de teste e conferir a seção 4 e o layout a 390 px. Step 5: commit "Tela: buscar vagas sem login e seção do agente."

### Task 10: Documentação

**Files:** Modify `README.md`, `.env.example`.

- [ ] Tirar `APP_USER/APP_PASSWORD`; avisar que o painel não tem login; documentar o agente, as variáveis (`OPENAI_API_KEY`, `OPENAI_API_URL`, `LUNA_MODEL`, `LUNA_TIMEOUT_MS`) e o que ele lê. `npm test` PASS. Commit "README: agente de triagem e painel sem login." Push.
