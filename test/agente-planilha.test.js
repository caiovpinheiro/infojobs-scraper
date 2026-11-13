'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { montarPlanilha, nomeDeAba } = require('../agente/planilha');

test('nomeDeAba respeita 31 caracteres, caracteres proibidos e repetição', () => {
  const usados = new Set(['Resumo']);
  const a = nomeDeAba('Op. Caixa / Loja [Mooca]: Centro e mais coisas longas', usados);
  assert.ok(a.length <= 31, a);
  assert.doesNotMatch(a, /[[\]:*?/\\]/);
  const b = nomeDeAba('Op. Caixa / Loja [Mooca]: Centro e mais coisas longas', usados);
  assert.notEqual(a, b);
  assert.ok(b.endsWith(' 2') && b.length <= 31, b);
  assert.equal(nomeDeAba('resumo', usados), 'resumo 2');
  assert.equal(nomeDeAba("'''", usados), 'Vaga');
});

function resultado() {
  const linha = (nome, nota) => ({ nome, idade: '25', bairro: 'Mooca, São Paulo', distanciaKm: 1.2, experiencia: 'Operador de Caixa (14 meses)',
    escolaridade: 'Ensino Médio completo', atendidos: 'Experiência com caixa', naoAtendidos: '—', nota,
    link: 'https://pandape.test/Company/Match/Matches/10?idvacancyfolder=77&idMatch=5', observacoes: 'não identificado' });
  return {
    geradoEm: new Date('2026-11-13T15:04:00-03:00'),
    resumo: [{ vaga: 'Operador de Caixa – Loja X', tipo: 'CLT', cep: '03101-000', ligadas: 'Operador de Caixa (10)', analisados: 3,
      semDistancia: 0, descartados: 1, aderentes: 2, meta: false, observacoes: 'Aderentes abaixo de 50.' }],
    abas: [{
      vaga: { id: '55', vagaId: '1203', cargo: 'Operador de Caixa', tipo: 'CLT', cep: '03101-000', empresa: 'Loja X', local: 'Mooca' },
      requisitos: { obrigatorios: ['Experiência com caixa'], desejaveis: ['Conhecer PDV'] },
      candidatos: [linha('Ana', 9.5), linha('Bia', 6)]
    }]
  };
}

test('montarPlanilha gera Resumo e uma aba por vaga com o formato pedido', async () => {
  const buffer = await montarPlanilha(resultado());
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const nomes = wb.worksheets.map(ws => ws.name);
  assert.equal(nomes[0], 'Resumo');
  assert.equal(nomes.length, 2);
  assert.match(nomes[1], /Operador de Caixa/);

  const resumo = wb.getWorksheet('Resumo');
  const titulos = resumo.getRow(1).values.slice(1);
  assert.ok(titulos.includes('Meta 50'));
  assert.ok(titulos.includes('Aderentes'));
  assert.equal(resumo.getRow(2).getCell(titulos.indexOf('Meta 50') + 1).value, 'não');
  assert.equal(resumo.views[0].state, 'frozen');

  const aba = wb.worksheets[1];
  assert.equal(aba.getCell('A1').value, 'ID da vaga');
  assert.equal(aba.getCell('B1').value, '1203');
  assert.equal(aba.getCell('B6').value, 'Experiência com caixa');
  assert.equal(aba.getCell('B7').value, 'Conhecer PDV');
  assert.equal(aba.getCell('A9').value, 'Nº');
  assert.equal(aba.getCell('L9').value, 'Observações');
  assert.equal(aba.getCell('B10').value, 'Ana');
  assert.equal(aba.getCell('J10').value, 9.5);
  assert.equal(aba.getCell('A11').value, 2);
  assert.equal(aba.getCell('K10').value.hyperlink, 'https://pandape.test/Company/Match/Matches/10?idvacancyfolder=77&idMatch=5');
  assert.equal(aba.views[0].state, 'frozen');
  assert.equal(aba.views[0].ySplit, 9);
  assert.ok(aba.autoFilter);
  const regras = aba.conditionalFormattings.flatMap(cf => cf.rules);
  assert.equal(regras.length, 2);
});

test('aba sem candidatos ainda tem cabeçalho e tabela', async () => {
  const r = resultado();
  r.abas[0].candidatos = [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await montarPlanilha(r));
  assert.equal(wb.worksheets[1].getCell('A9').value, 'Nº');
});

test('final: apóstrofo no corte e nome reservado não quebram a planilha', async () => {
  const usados = new Set(['Resumo']);
  const nome = nomeDeAba("Operador de Caixa Loja Santa d' Oeste", usados);
  assert.doesNotMatch(nome, /^'|'$/);
  assert.notEqual(nomeDeAba('History', usados).toLowerCase(), 'history');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await montarPlanilha({ resumo: [], abas: [{ vaga: { id: '1', cargo: "Operador de Caixa Loja Santa d'", local: 'Oeste', tipo: 'CLT' }, requisitos: {}, candidatos: [] },
    { vaga: { id: '2', cargo: 'History', tipo: 'CLT' }, requisitos: {}, candidatos: [] }] }));
  assert.equal(wb.worksheets.length, 3);
});
