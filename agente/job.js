'use strict';

// Orquestra o agente: para cada vaga do sistema da DNA ligada a vagas do Pandapé,
// distância e idade no código, leitura do currículo pela IA, descarte, nota e ordem.

const { perfilDoHtml } = require('./texto');
const { distanciaKm, descarte, nota, ordenar } = require('./regras');
const { textoDaVaga } = require('./vagas');

const NI = 'não identificado';
const META = 50;
const CONCORRENCIA_IA = 4;
// Idade e distância são conferidas pelo código: não entram na proporção de obrigatórios da IA.
const CONFERIDO_NO_CODIGO = /\bidade\b|\banos de idade\b|dist[aâ]ncia|\bkm\b|\bmorar? (?:perto|pr[oó]xim)/i;
function semConferidosNoCodigo(lista) { return (Array.isArray(lista) ? lista : []).filter(item => !CONFERIDO_NO_CODIGO.test(typeof item === 'string' ? item : item?.requisito || '')); }

function tempo(meses) {
  if (!Number.isInteger(meses) || meses < 0) return null;
  const anos = Math.floor(meses / 12);
  const resto = meses % 12;
  const partes = [];
  if (anos) partes.push(`${anos} ${anos === 1 ? 'ano' : 'anos'}`);
  if (resto || !anos) partes.push(`${resto} ${resto === 1 ? 'mês' : 'meses'}`);
  return partes.join(' e ');
}

function chavePessoa(c) {
  const digitos = String(c.telefone || '').replace(/\D/g, '');
  if (digitos) return `tel:${digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos}`;
  if (c.nome && c.nascimento) return `nome:${String(c.nome).trim().toLowerCase()}|${c.nascimento}`;
  return `key:${c.key}`;
}

function rotuloVaga(vaga) {
  return `${vaga.cargo} – ${vaga.empresa || vaga.local || `vaga ${vaga.vagaId || vaga.id}`}`;
}

function bairro(endereco) {
  const limpo = String(endereco || '').replace(/[\s,.]+$/g, '').replace(/,\s*,/g, ',').trim();
  return limpo || null;
}

async function emParalelo(itens, limite, fn) {
  let proximo = 0;
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (proximo < itens.length) { const i = proximo++; await fn(itens[i], i); }
  }));
}

function plural(n, singular, pluralForma) { return `${n} ${n === 1 ? singular : pluralForma}`; }

function linhaCandidato(item, pandapeBase) {
  const { c, aval, km, nota: n } = item;
  const funcao = aval.experiencia_funcao;
  const duracao = tempo(aval.experiencia_meses);
  const experiencia = funcao ? `${funcao}${duracao ? ` (${duracao})` : ''}` : aval.experiencia === 'nenhuma' ? 'sem experiência' : NI;
  const estudo = [aval.escolaridade, aval.curso, aval.semestre].filter(Boolean).join(' / ') || NI;
  const todos = [...(aval.obrigatorios || []), ...(aval.desejaveis || [])];
  const atendidos = todos.filter(r => r.situacao === 'atendido').map(r => r.requisito).join('; ') || '—';
  const naoAtendidos = todos.filter(r => r.situacao !== 'atendido')
    .map(r => r.situacao === 'nao_identificado' ? `${r.requisito} (não identificado)` : r.requisito).join('; ') || '—';
  return {
    nome: c.nome || NI,
    idade: Number.isInteger(c.idade) ? String(c.idade) : NI,
    bairro: bairro(c.endereco) || NI,
    distanciaKm: Math.round(km * 10) / 10,
    experiencia,
    escolaridade: estudo,
    atendidos,
    naoAtendidos,
    nota: n,
    link: `${pandapeBase}/Company/Match/Matches/${c.idVacancy}?idvacancyfolder=${c.folderId}&idMatch=${c.idMatch}`,
    observacoes: [aval.observacoes, ...item.extras].filter(Boolean).join(' | ')
  };
}

async function executarAgente({ ligacoes, vagasPandape, candidatos, vagasDna, deps, progresso = () => {}, avisoGeral = '' }) {
  const { ia, geo, perfilHtml, pandapeBase } = deps;
  const porId = new Map(vagasDna.map(v => [String(v.id), v]));
  const tituloPandape = new Map(vagasPandape.map(v => [String(v.id), v.title || `Vaga ${v.id}`]));
  const grupos = new Map();
  const ligadas = new Set();
  for (const { idVacancy, vagaDnaId } of ligacoes) {
    const vaga = porId.get(String(vagaDnaId));
    if (!vaga) continue;
    ligadas.add(String(idVacancy));
    if (!grupos.has(vaga.id)) grupos.set(vaga.id, { vaga, pandape: [] });
    grupos.get(vaga.id).pandape.push(String(idVacancy));
  }

  // Pessoas únicas por vaga DNA (mesma pessoa inscrita em duas vagas do Pandapé ligadas à mesma vaga conta uma vez).
  for (const grupo of grupos.values()) {
    const vistos = new Map();
    for (const c of candidatos) {
      if (!grupo.pandape.includes(String(c.idVacancy))) continue;
      const chave = chavePessoa(c);
      if (!vistos.has(chave)) vistos.set(chave, c);
    }
    grupo.pessoas = [...vistos.entries()].map(([chave, c]) => ({ chave, c }));
  }
  const total = [...grupos.values()].reduce((soma, g) => soma + g.pessoas.length, 0);
  let feitos = 0;
  const avancar = fase => { progresso({ feitos, total, fase }); };
  avancar('iniciando');

  const resumo = [];
  const abas = [];
  for (const grupo of grupos.values()) {
    const { vaga } = grupo;
    const linha = {
      vaga: rotuloVaga(vaga), tipo: vaga.tipo === 'ESTAGIO' ? 'Estágio' : 'CLT', cep: vaga.cep || NI,
      ligadas: grupo.pandape.map(id => `${tituloPandape.get(id) || 'Vaga'} (${id})`).join('; '),
      analisados: grupo.pessoas.length, semDistancia: 0, descartados: 0, aderentes: 0, meta: false, observacoes: ''
    };
    const notas = [];
    resumo.push(linha);
    const pularGrupo = motivo => {
      notas.push(motivo);
      feitos += grupo.pessoas.length;
      avancar(rotuloVaga(vaga));
      linha.observacoes = [...notas, avisoGeral].filter(Boolean).join(' ');
    };

    const pontoVaga = Number.isFinite(vaga.lat) && Number.isFinite(vaga.lng) ? { lat: vaga.lat, lng: vaga.lng } : await geo.pontoDoCep(vaga.cep);
    if (!pontoVaga) { pularGrupo('CEP pendente: a vaga não tem coordenada nem CEP localizável. Não foi avaliada.'); continue; }

    let req;
    try {
      req = await ia.requisitosDaVaga(textoDaVaga(vaga));
      req = { ...req, obrigatorios: semConferidosNoCodigo(req.obrigatorios), desejaveis: semConferidosNoCodigo(req.desejaveis) };
    }
    catch (error) { pularGrupo(`Falha ao ler os requisitos da vaga pela IA (${error.code || 'erro'}). Não foi avaliada.`); continue; }
    if (req.interpretacoes?.length) notas.push(`Interpretações: ${req.interpretacoes.join('; ')}.`);

    const regra = {
      tipo: vaga.tipo,
      idadeMin: vaga.idade ?? req.idade_min ?? (vaga.tipo === 'CLT' ? 18 : null),
      idadeMax: vaga.idadeAte ?? req.idade_max ?? null,
      aceitaMedioTecnico: vaga.tipo === 'ESTAGIO' ? req.aceita_medio_tecnico : null
    };
    const texto = textoDaVaga(vaga);
    const aprovados = [];
    const motivos = new Map();
    let ilegiveis = 0;
    let semAcesso = 0;
    let falhas = 0;
    const descartar = motivo => { linha.descartados++; motivos.set(motivo, (motivos.get(motivo) || 0) + 1); };

    await emParalelo(grupo.pessoas, CONCORRENCIA_IA, async ({ chave, c }) => {
      try {
        const pontoPessoa = await geo.pontoDoCep(c.cep);
        if (!pontoPessoa) { linha.semDistancia++; return; }
        const km = c.cep && vaga.cep && String(c.cep).replace(/\D/g, '') === String(vaga.cep).replace(/\D/g, '') ? 0 : distanciaKm(pontoPessoa, pontoVaga);
        const antes = descarte(regra, { idade: c.idade, distanciaKm: km }, null);
        if (antes) { descartar(antes); return; }
        let html;
        try { html = await perfilHtml(c); } catch { semAcesso++; return; }
        const perfil = perfilDoHtml(html);
        if (!perfil) { ilegiveis++; linha.descartados++; return; }
        let aval;
        try { aval = await ia.avaliar(texto, req, perfil); }
        catch { falhas++; return; }
        aval = { ...aval, obrigatorios: semConferidosNoCodigo(aval.obrigatorios), desejaveis: semConferidosNoCodigo(aval.desejaveis) };
        const depois = descarte(regra, { idade: c.idade, distanciaKm: km }, aval);
        if (depois) { descartar(depois); return; }
        aprovados.push({ chave, c, aval, km, distanciaKm: km, nota: nota(aval, km), extras: [] });
      } finally {
        feitos++;
        avancar(rotuloVaga(vaga));
      }
    });

    linha.aderentes = aprovados.length;
    linha.meta = aprovados.length >= META;
    if (!linha.meta) notas.push(`Aderentes abaixo de ${META} (${aprovados.length} de ${grupo.pessoas.length} inscritos analisados).`);
    if (linha.semDistancia) notas.push(`${plural(linha.semDistancia, 'pessoa sem CEP localizável ficou', 'pessoas sem CEP localizável ficaram')} fora.`);
    if (motivos.size) notas.push(`Descartes: ${[...motivos].map(([m, n]) => `${m} (${n})`).join('; ')}.`);
    if (ilegiveis) notas.push(`${plural(ilegiveis, 'perfil ilegível', 'perfis ilegíveis')} no Pandapé.`);
    if (semAcesso) notas.push(`${plural(semAcesso, 'perfil não abriu', 'perfis não abriram')} no Pandapé (sessão expirada ou acesso negado): ${semAcesso === 1 ? 'ficou' : 'ficaram'} sem avaliação.`);
    if (falhas) notas.push(`${plural(falhas, 'falha', 'falhas')} da IA: ${falhas === 1 ? 'a pessoa ficou' : 'as pessoas ficaram'} sem avaliação.`);
    linha.observacoes = [...notas, avisoGeral].filter(Boolean).join(' ');
    abas.push({ vaga, requisitos: req, ligadas: grupo.pandape, aprovados });
  }

  // "Também apto para": mesma pessoa aprovada em mais de uma vaga do sistema da DNA.
  const ondeAprovado = new Map();
  for (const aba of abas) for (const item of aba.aprovados) {
    if (!ondeAprovado.has(item.chave)) ondeAprovado.set(item.chave, []);
    ondeAprovado.get(item.chave).push(rotuloVaga(aba.vaga));
  }
  for (const aba of abas) for (const item of aba.aprovados) {
    const outras = ondeAprovado.get(item.chave).filter(rotulo => rotulo !== rotuloVaga(aba.vaga));
    if (outras.length) item.extras.push(`também apto para: ${outras.join('; ')}`);
  }

  for (const vaga of vagasPandape) {
    if (ligadas.has(String(vaga.id))) continue;
    resumo.push({ vaga: `${vaga.title || 'Vaga'} (Pandapé ${vaga.id})`, tipo: vaga.type === 'ESTAGIO' ? 'Estágio' : vaga.type === 'CLT' ? 'CLT' : NI,
      cep: NI, ligadas: `${vaga.title || 'Vaga'} (${vaga.id})`, analisados: 0, semDistancia: 0, descartados: 0, aderentes: 0, meta: false,
      observacoes: 'sem vaga correspondente no sistema da DNA: não foi avaliada.' });
  }

  avancar('concluído');
  return {
    geradoEm: new Date(),
    resumo,
    abas: abas.map(aba => ({ vaga: aba.vaga, requisitos: aba.requisitos, ligadas: aba.ligadas,
      candidatos: ordenar(aba.aprovados).map(item => linhaCandidato(item, pandapeBase)) }))
  };
}

module.exports = { executarAgente, tempo, chavePessoa };
