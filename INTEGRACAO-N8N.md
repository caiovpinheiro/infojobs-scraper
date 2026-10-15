# Painel Pandapé: leitura do fluxo e integração

## O que o workflow enviado faz hoje

1. O Discord chama `Webhook - Discord Interactions`. O nó `Verificar Assinatura Ed25519` valida a assinatura da interação; PING recebe PONG; o canal é validado; Discord recebe uma resposta inicial de processamento.
2. `Cookie Pandapé` fornece a sessão autenticada usada nas chamadas internas do Pandapé. O comando `/infojobs-status` apenas informa que foi desativado.
3. No caminho geral, `1. Scraping Pandape` busca **a primeira página de até 100 vagas**, abre cada processo, localiza a aba **Inscritos**, pagina os inscritos, com limite de **24 verificados por processo** e limite global informado no comando. Para cada pessoa, tenta mover para **Pré-selecionado**, reconfere a diminuição do total de inscritos e busca o telefone na página de detalhe.
4. `/infojobs-vaga` usa uma variante que recebe o código/link de uma vaga e um número de candidatos, com teto de segurança de **500** e sem limite de 24 nessa vaga. Também move antes de consultar o CRM.
5. `2. CRM Dedup + Envio WhatsApp` ignora pessoas sem telefone; procura contato e primeiro negócio retornado pelo CRM. Se o negócio está em **Perdido**, permite reengajamento após **7 dias**, no máximo **50 por execução**; se está em qualquer outra etapa, pula. Se não encontra contato/negócio, envia o template `chamada_vaga_vista_fora_sem_vinculo` pela Meta. Processa até **6 candidatos ao mesmo tempo**. Após confirmação de envio, chama um webhook para registrar origem/campanha.
6. `3. Resumo Discord + Lote 2h` conta verificados, movidos, enviados, reengajados e pulados, avisa sobre possível cookie vencido, publica o resumo no Discord e manda os envios confirmados para um segundo webhook de checagem após duas horas. O comportamento interno dessa segunda automação não está no arquivo enviado.
7. `/infojobs-teste` é outro caminho: coleta candidatos, CEP, move de pasta, cria contato e negócio se ainda não houver, adiciona nota/tag e envia WhatsApp. É uma operação real apesar do nome “teste”.

**Cuidado com os números:** o `teto` atual limita candidatos **verificados**, não mensagens efetivamente enviadas. Um candidato pode ser movido e depois não receber WhatsApp por falta de telefone, por já existir negócio ativo ou por falha da Meta.

## Onde alterar cada regra

| Ajuste | Ponto atual |
| --- | --- |
| Quantidade do lote geral | Opção Discord `data.options[0].value`, lida em `1. Scraping Pandape` |
| Máximo por vaga no lote geral | `MAX_POR_PROCESSO = 24` em `1. Scraping Pandape` |
| Teto da vaga específica | `MAX_CANDIDATOS_HARD_SAFETY = 500` em `1b. Scraping Pandape - Vaga Unica` |
| Vagas examinadas | `pandapeListVacancies(100)`; hoje só página 1 |
| Pasta de origem e destino | Extração de `Inscritos` e `Pré-selecionado`; `moveToPreSelecionado` |
| Deduplicação / reengajamento | `2. CRM Dedup + Envio WhatsApp`; janela de 7 dias, teto 50 |
| Mensagem WhatsApp | Função `sendWhatsApp` no nó 2; template Meta |
| Criação de negócio, nota e tag | Apenas no caminho `/infojobs-teste`, nó `2c` |
| Categoria CLT/estágio | **Não existe** no código entregue. É preciso mapear cada vaga pelo ID ou obter um campo confiável do Pandapé. Não classificar apenas pelo título. |

## Arquitetura para o HTML

O arquivo `index.html` é estático e pode ir ao GitHub Pages. Ele mostra uma demonstração com dados fictícios. Para consultar e ativar pessoas reais, o servidor precisa fornecer três endpoints sob uma base HTTPS que termine em `/webhook/`:

| Método e caminho | Função | Resposta esperada |
| --- | --- | --- |
| `POST infojobs-preview` | Lê as vagas e os inscritos, sem mover, enviar WhatsApp nem alterar CRM | `{ "snapshotId": "id-opaco", "candidates": [{ "idMatch": "123", "idVacancy": "456", "nome": "Nome", "vaga": "Título", "tipo": "CLT" }] }` |
| `POST infojobs-ativar` | Valida `snapshotId`, `tipo`, `quantidade` e `requestId`, grava lote único e dispara o processamento assíncrono | `{ "jobId": "lote-123", "status": "queued" }` |
| `GET infojobs-status?jobId=...` | Consulta o estado do lote | `{ "status": "running", "reviewed": 2, "moved": 1, "sent": 1, "skipped": 1, "errors": [] }` |

O botão de confirmação envia `{ "snapshotId": "...", "tipo": "CLT" | "ESTAGIO", "quantidade": 20, "requestId": "uuid" }`. Um `status` final deve ser `completed` ou `failed`. O HTML **não envia IDs individuais** para determinar a fila; o servidor é a autoridade. Todas as respostas devem ser JSON.

### Nós a acrescentar no n8n

1. **Prévia:** `Webhook POST /infojobs-preview` com autenticação de cabeçalho → scraping de vagas/inscritos reaproveitado do nó 1, **sem** `MoveToFolder` e **sem** consulta de telefone → classificação pelo `idVacancy` → criação de `snapshotId` com validade curta → `Respond to Webhook` com nomes, vaga e categoria. Para listas longas, paginar também `ListVacancies`, pois hoje apenas 100 vagas são consideradas.
2. **Ativação:** `Webhook POST /infojobs-ativar` com a mesma autenticação → validar inteiros `1..500`, categoria permitida e snapshot recente → consultar os candidatos ainda presentes em **Inscritos** → selecionar apenas vagas do tipo pedido → registrar `requestId` único antes de aceitar → responder `jobId` rapidamente → executar o lote em segundo workflow. O servidor decide se a quantidade significa **verificados** ou **WhatsApps enviados**. O HTML assume *verificados*, como no workflow atual.
3. **Processamento:** para cada candidato, reconfirmar a pasta e o tipo da vaga, decidir elegibilidade no CRM e então aplicar a ordem de operações escolhida. Recomendo mover para **Pré-selecionado somente após envio confirmado** se a intenção é que “ativado” corresponda a WhatsApp enviado; esta é uma mudança de regra em relação ao fluxo atual. Gravar resultado por candidato e atualizar contadores do lote em armazenamento persistente.
4. **Estado:** `Webhook GET /infojobs-status` autenticado → buscar o lote salvo por `jobId` → devolver totais e erros. O estado e `requestId` precisam persistir fora da memória de uma execução (por exemplo no banco já usado pelo n8n/CRM).

### Duas decisões de negócio antes da ligação real

- **De onde vem CLT/estágio:** idealmente um campo estruturado por `idVacancy` no Pandapé. Se não estiver disponível nessa resposta, manter um cadastro de vagas e tipo no banco. Vagas não classificadas aparecem na lista, mas ficam fora da ativação.
- **Quando mover para Pré-selecionado:** o workflow atual move todo candidato verificado, mesmo que não envie mensagem. Se a nova operação for “ativar quem recebeu WhatsApp”, mover após envio confirmado. Também é necessário definir se o limite escolhido conta pessoas examinadas ou mensagens enviadas.

### Segurança e publicação

- O JSON enviado contém cookie de sessão do Pandapé, chave do CRM, token da Meta e URL de webhook do Discord diretamente nos nós. **Revogue/renove esses valores antes de publicar qualquer parte do workflow**; nunca suba o JSON original ao GitHub. Coloque segredos em credenciais/ambiente do servidor.
- Um GitHub Pages público não guarda segredos. O HTML pede uma chave ao operador e a mantém só na aba aberta; ambos os webhooks precisam validar a chave no servidor. Configure HTTPS, autenticação e CORS para o domínio do GitHub Pages, incluindo a resposta à requisição `OPTIONS` prévia. A restrição de CORS, sozinha, não substitui autenticação.
- A prévia deve evitar retornar telefones. A ativação deve validar categoria e limite no servidor, impedir lotes duplicados por `requestId`, reconfirmar a vaga e o candidato antes de agir, e registrar auditoria por usuário e lote.
- Publique no GitHub somente `index.html`. Abra-o em GitHub Pages, use **Ver exemplo** para validar a interface e configure a URL/chave apenas após os webhooks estarem prontos. A página por si só não executa a automação.
