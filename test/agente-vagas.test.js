'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listarVagasDna, textoDaVaga } = require('../agente/vagas');

const LINHA = {
  id: '55', vaga_id: '1203', tipo_vaga: 2, cargo: 'Operador de Caixa', salario: '1800.00', beneficios: 'VT e VR',
  idade: 18, idade_ate: 0, horario: '2=08:00-17:00;3=08:00-17:00', carga_horaria: '44', escolaridade: '3',
  atividades: 'Atender clientes no caixa.', descricao: null, requisitos: 'Experiência com caixa. Desejável: conhecer PDV.',
  cep: '03101-000', latitude: '-23.55', longitude: '0', nome_fantasia: 'Loja X', local: 'Mooca, São Paulo'
};

function poolFalso(respostas) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql, params });
      const r = respostas.shift();
      if (r instanceof Error) throw r;
      return { rows: r };
    }
  };
}

test('consulta completa cai para a básica e traduz os campos', async () => {
  const pool = poolFalso([Object.assign(new Error('coluna'), { code: '42703' }), [LINHA, { ...LINHA, id: '56', tipo_vaga: 1, latitude: null, longitude: null, escolaridade: null }], [{ id: '3', valor: 'Ensino Médio' }]]);
  const vagas = await listarVagasDna(pool);
  assert.equal(pool.consultas.length, 3);
  assert.match(pool.consultas[0].sql, /public\.cargo/);
  assert.doesNotMatch(pool.consultas[1].sql, /v\.descricao|v\.requisitos/);
  assert.equal(vagas[0].tipo, 'CLT');
  assert.equal(vagas[1].tipo, 'ESTAGIO');
  assert.equal(vagas[0].escolaridade, 'Ensino Médio');
  assert.equal(vagas[1].escolaridade, null);
  assert.equal(vagas[0].horario, 'segunda e terça, 08:00 às 17:00');
  assert.equal(vagas[0].idade, 18);
  assert.equal(vagas[0].idadeAte, null);
  assert.equal(vagas[0].lat, null);
  assert.equal(vagas[0].lng, null);
  assert.equal(vagas[0].empresa, 'Loja X');
  assert.equal(vagas[0].vagaId, '1203');
});

test('flex com erro deixa escolaridade nula; outro erro do banco sobe', async () => {
  const pool = poolFalso([[{ ...LINHA, latitude: '-23.5', longitude: '-46.6' }], Object.assign(new Error('sem tabela'), { code: '42P01' })]);
  const [vaga] = await listarVagasDna(pool);
  assert.equal(vaga.escolaridade, null);
  assert.deepEqual([vaga.lat, vaga.lng], [-23.5, -46.6]);
  await assert.rejects(() => listarVagasDna(poolFalso([Object.assign(new Error('caiu'), { code: '57P01' })])), /caiu/);
});

test('textoDaVaga não leva empresa nem CEP', async () => {
  const [vaga] = await listarVagasDna(poolFalso([[LINHA], [{ id: '3', valor: 'Ensino Médio' }]]));
  const texto = textoDaVaga(vaga);
  assert.match(texto, /Operador de Caixa/);
  assert.match(texto, /CLT/);
  assert.match(texto, /Experiência com caixa/);
  assert.match(texto, /Ensino Médio/);
  assert.match(texto, /segunda e terça/);
  assert.doesNotMatch(texto, /Loja X|03101|Mooca/);
});
