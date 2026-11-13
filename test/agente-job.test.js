'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executarAgente, tempo } = require('../agente/job');

const PONTOS = { '03101000': { lat: -23.55, lng: -46.60 }, '03102000': { lat: -23.56, lng: -46.61 }, '09000000': { lat: -23.65, lng: -46.53 } };
const REQ = { obrigatorios: ['Experiência em caixa', 'Ensino médio completo'], desejaveis: ['PDV'], idade_min: null, idade_max: null, aceita_medio_tecnico: null, interpretacoes: ['"PDV" entendido como sistema de caixa'] };
function aval(extra = {}) {
  return { experiencia: 'mesma', experiencia_funcao: 'Operador de Caixa', experiencia_meses: 16, escolaridade: 'Ensino Médio completo', curso: null,
    semestre: null, nivel: 'medio', matricula_ativa: null, formado: null,
    obrigatorios: [{ requisito: 'Experiência em caixa', situacao: 'atendido' }, { requisito: 'Ensino médio completo', situacao: 'nao_identificado' }],
    desejaveis: [{ requisito: 'PDV', situacao: 'atendido' }], observacoes: 'ok', ...extra };
}
function pessoa(id, vaga, extra = {}) {
  return { key: `${vaga}:${id}`, idMatch: id, idVacancy: vaga, folderId: '77', nome: `Pessoa ${id}`, telefone: `55119888800${id}`, cep: '03102-000',
    endereco: 'Mooca, São Paulo, SP', nascimento: '2000-01-01', idade: 26, ...extra };
}

function deps(perfis, opcoes = {}) {
  const avaliados = [];
  return {
    avaliados,
    ia: {
      pronta: true,
      async requisitosDaVaga() { if (opcoes.reqFalha) throw new Error('IA_INDISPONIVEL: x'); return REQ; },
      async avaliar(vagaTexto, req, perfil) {
        avaliados.push(perfil);
        const r = perfis[perfil];
        if (r instanceof Error) throw r;
        return r;
      }
    },
    geo: { async pontoDoCep(cep) { return PONTOS[String(cep || '').replace(/\D/g, '')] || null; } },
    async perfilHtml(c) { return c.idMatch === 'ilegivel' ? '<html>erro</html>' : `<div id="ResumeProfile">perfil-${c.idMatch}</div><div id="ResumePersonalInformationContainer">`; },
    pandapeBase: 'https://pandape.test'
  };
}

const VAGA_A = { id: 'A', vagaId: '1203', tipo: 'CLT', cargo: 'Operador de Caixa', cep: '03101-000', lat: -23.55, lng: -46.60, empresa: 'Loja X', local: 'Mooca', idade: null, idadeAte: null };
const VAGA_B = { id: 'B', vagaId: '1300', tipo: 'CLT', cargo: 'Repositor', cep: '03101000', lat: null, lng: null, empresa: 'Loja Y', local: 'Brás', idade: null, idadeAte: null };
const VAGA_C = { id: 'C', vagaId: '1400', tipo: 'CLT', cargo: 'Fiscal', cep: null, lat: null, lng: null, empresa: 'Loja Z', local: 'Sé', idade: null, idadeAte: null };

test('corta 8 km antes da IA, descarta, ordena e marca duplicidades', async () => {
  const perfis = {
    'perfil-1': aval(),
    'perfil-2': aval({ experiencia: 'sem_relacao' }),
    'perfil-5': aval({ experiencia: 'relacionada', experiencia_meses: 3 }),
    'perfil-6': new Error('IA_INDISPONIVEL: caiu')
  };
  const d = deps(perfis);
  const candidatos = [
    pessoa('1', '10'),
    pessoa('2', '10'),
    pessoa('3', '10', { cep: '09000-000' }),
    pessoa('4', '10', { cep: null }),
    pessoa('1', '11'),
    pessoa('5', '11', { idade: null }),
    pessoa('6', '11'),
    pessoa('7', '11', { idade: 16 }),
    { ...pessoa('ilegivel', '11'), telefone: null, nome: 'Sem Perfil' },
    pessoa('1', '12')
  ];
  const progresso = [];
  const r = await executarAgente({
    ligacoes: [{ idVacancy: '10', vagaDnaId: 'A' }, { idVacancy: '11', vagaDnaId: 'A' }, { idVacancy: '12', vagaDnaId: 'B' }, { idVacancy: '13', vagaDnaId: 'C' }],
    vagasPandape: [{ id: '10', title: 'Caixa Mooca', type: 'CLT' }, { id: '11', title: 'Caixa 2', type: 'CLT' }, { id: '12', title: 'Repositor', type: 'CLT' },
      { id: '13', title: 'Fiscal', type: 'CLT' }, { id: '14', title: 'Motorista', type: 'CLT' }],
    candidatos, vagasDna: [VAGA_A, VAGA_B, VAGA_C], deps: d, progresso: p => progresso.push(p), avisoGeral: 'A busca parou no teto.'
  });

  assert.equal(d.avaliados.includes('perfil-3'), false, '9 km não vai para a IA');
  assert.equal(d.avaliados.includes('perfil-7'), false, 'menor de 18 não vai para a IA');
  assert.equal(d.avaliados.filter(p => p === 'perfil-1').length, 2, 'uma vez por vaga DNA');

  const abaA = r.abas.find(a => a.vaga.id === 'A');
  assert.deepEqual(abaA.candidatos.map(c => c.nome), ['Pessoa 1', 'Pessoa 5']);
  const [primeiro, segundo] = abaA.candidatos;
  assert.equal(primeiro.nota, 7.5);
  assert.equal(primeiro.experiencia, 'Operador de Caixa (1 ano e 4 meses)');
  assert.equal(primeiro.atendidos, 'Experiência em caixa; PDV');
  assert.match(primeiro.naoAtendidos, /Ensino médio completo \(não identificado\)/);
  assert.match(primeiro.observacoes, /também apto para: Repositor – Loja Y/);
  assert.equal(primeiro.link, 'https://pandape.test/Company/Match/Matches/10?idvacancyfolder=77&idMatch=1');
  assert.equal(primeiro.distanciaKm, 1.5);
  assert.equal(segundo.idade, 'não identificado');

  const resumoA = r.resumo.find(l => l.vaga === 'Operador de Caixa – Loja X');
  assert.equal(resumoA.analisados, 8);
  assert.equal(resumoA.semDistancia, 1);
  assert.equal(resumoA.descartados, 4);
  assert.equal(resumoA.aderentes, 2);
  assert.equal(resumoA.meta, false);
  assert.match(resumoA.observacoes, /PDV/);
  assert.match(resumoA.observacoes, /1 falha/);
  assert.match(resumoA.observacoes, /1 perfil ilegível/);
  assert.match(resumoA.observacoes, /A busca parou no teto/);

  const abaB = r.abas.find(a => a.vaga.id === 'B');
  assert.equal(abaB.candidatos.length, 1);
  assert.match(abaB.candidatos[0].observacoes, /também apto para: Operador de Caixa – Loja X/);

  assert.equal(r.abas.some(a => a.vaga.id === 'C'), false);
  assert.match(r.resumo.find(l => l.vaga.startsWith('Fiscal')).observacoes, /CEP pendente/);
  assert.match(r.resumo.find(l => l.vaga.startsWith('Motorista')).observacoes, /sem vaga correspondente/);
  assert.equal(progresso.at(-1).feitos, progresso.at(-1).total);
});

test('falha ao ler requisitos não derruba as outras vagas', async () => {
  const d = deps({}, { reqFalha: true });
  const r = await executarAgente({ ligacoes: [{ idVacancy: '10', vagaDnaId: 'A' }], vagasPandape: [{ id: '10', title: 'Caixa', type: 'CLT' }],
    candidatos: [pessoa('1', '10')], vagasDna: [VAGA_A], deps: d, progresso() {} });
  assert.equal(r.abas.length, 0);
  assert.match(r.resumo[0].observacoes, /requisitos/);
});

test('tempo em meses vira texto', () => {
  assert.equal(tempo(16), '1 ano e 4 meses');
  assert.equal(tempo(24), '2 anos');
  assert.equal(tempo(1), '1 mês');
  assert.equal(tempo(null), null);
});

test('final: idade e distância não contam nos obrigatórios e erro do Pandapé não vira perfil ilegível', async () => {
  const d = deps({ 'perfil-1': aval({ obrigatorios: [{ requisito: 'Experiência em caixa', situacao: 'atendido' }, { requisito: 'Idade entre 18 e 30 anos', situacao: 'nao_identificado' }] }) });
  d.ia.requisitosDaVaga = async () => ({ ...REQ, obrigatorios: ['Experiência em caixa', 'Idade entre 18 e 30 anos', 'Morar a até 5 km da loja'] });
  const original = d.perfilHtml;
  d.perfilHtml = async c => { if (c.idMatch === '2') throw new Error('Sessão do Pandapé expirou'); return original(c); };
  const r = await executarAgente({ ligacoes: [{ idVacancy: '10', vagaDnaId: 'A' }], vagasPandape: [{ id: '10', title: 'Caixa', type: 'CLT' }],
    candidatos: [pessoa('1', '10'), pessoa('2', '10')], vagasDna: [VAGA_A], deps: d, progresso() {} });
  const [c] = r.abas[0].candidatos;
  assert.equal(c.nota, 10);
  assert.doesNotMatch(c.naoAtendidos, /Idade/);
  assert.deepEqual(r.abas[0].requisitos.obrigatorios, ['Experiência em caixa']);
  assert.equal(r.resumo[0].descartados, 0);
  assert.match(r.resumo[0].observacoes, /1 perfil não abriu no Pandapé/);
  assert.doesNotMatch(r.resumo[0].observacoes, /ilegível/);
});
