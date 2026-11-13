'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarIa } = require('../agente/ia');
const { PROMPT_AVALIACAO, PROMPT_REQUISITOS, SCHEMA_AVALIACAO, SCHEMA_REQUISITOS } = require('../agente/prompts');

const AVAL = { experiencia: 'mesma', experiencia_funcao: 'Operador de Caixa', experiencia_meses: 14, escolaridade: 'Ensino Médio completo',
  curso: null, semestre: null, nivel: 'medio', matricula_ativa: null, formado: null,
  obrigatorios: [{ requisito: 'Experiência em caixa', situacao: 'atendido' }], desejaveis: [], observacoes: '' };

function ok(objeto, comoOutput = true) {
  const texto = JSON.stringify(objeto);
  const corpo = comoOutput ? { output: [{ type: 'message', content: [{ type: 'output_text', text: texto }] }] } : { output_text: texto };
  return { ok: true, status: 200, text: async () => JSON.stringify(corpo) };
}
function erro(status) { return { ok: false, status, text: async () => '{"error":{"message":"x"}}' }; }
function fetchSequencia(respostas) {
  const chamadas = [];
  const fn = async (url, opcoes) => {
    chamadas.push({ url, opcoes, corpo: JSON.parse(opcoes.body) });
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  fn.chamadas = chamadas;
  return fn;
}
const base = { url: 'https://openai.test/v1/', key: 'k', model: 'gpt-6-luna', timeoutMs: 1000, esperaMs: 1 };

test('monta o pedido com store false, schema e chave', async () => {
  const fetch = fetchSequencia([ok(AVAL)]);
  const ia = criarIa({ ...base, fetch });
  assert.equal(ia.pronta, true);
  const resposta = await ia.avaliar('Vaga: Operador de Caixa', { obrigatorios: ['Experiência em caixa'], desejaveis: [] }, 'Experiência\nOperador de Caixa');
  assert.deepEqual(resposta, AVAL);
  const { url, opcoes, corpo } = fetch.chamadas[0];
  assert.equal(url, 'https://openai.test/v1/responses');
  assert.equal(opcoes.headers.Authorization, 'Bearer k');
  assert.equal(corpo.store, false);
  assert.equal(corpo.model, 'gpt-6-luna');
  assert.equal(corpo.text.format.type, 'json_schema');
  assert.equal(corpo.text.format.strict, true);
  assert.equal(corpo.instructions, PROMPT_AVALIACAO);
  assert.match(corpo.input[0].content[0].text, /Operador de Caixa/);
});

test('HTTP 400 repete sem schema; 500 tenta de novo; texto inválido falha', async () => {
  let fetch = fetchSequencia([erro(400), ok({ obrigatorios: ['a'], desejaveis: [], idade_min: 18, idade_max: null, aceita_medio_tecnico: null, interpretacoes: [] }, false)]);
  let ia = criarIa({ ...base, fetch });
  const req = await ia.requisitosDaVaga('Vaga X');
  assert.deepEqual(req.obrigatorios, ['a']);
  assert.equal(fetch.chamadas[1].corpo.text, undefined);
  assert.match(fetch.chamadas[1].corpo.input[0].content[0].text, /JSON/);

  fetch = fetchSequencia([erro(500), ok(AVAL)]);
  ia = criarIa({ ...base, fetch });
  assert.equal((await ia.avaliar('v', {}, 'p')).experiencia, 'mesma');
  assert.equal(fetch.chamadas.length, 2);

  fetch = fetchSequencia([new Error('timeout'), new Error('timeout')]);
  ia = criarIa({ ...base, fetch });
  await assert.rejects(() => ia.avaliar('v', {}, 'p'), /IA_INDISPONIVEL/);

  fetch = fetchSequencia([{ ok: true, status: 200, text: async () => JSON.stringify({ output_text: 'não sei' }) }]);
  ia = criarIa({ ...base, fetch });
  await assert.rejects(() => ia.avaliar('v', {}, 'p'), /IA_FORMATO/);

  fetch = fetchSequencia([ok({ experiencia: 'talvez' })]);
  ia = criarIa({ ...base, fetch });
  await assert.rejects(() => ia.avaliar('v', {}, 'p'), /IA_FORMATO/);
});

test('sem chave não fica pronta', () => {
  assert.equal(criarIa({ ...base, key: '' }).pronta, false);
});

test('prompts trazem o mapa de experiência e as regras de estágio', () => {
  for (const trecho of ['Operador de Caixa', 'Repositor', 'Balconista', 'Auxiliar de Loja', 'Atendente', 'administrativ', 'Matrícula ativa', 'não identificado', '6 meses']) {
    assert.match(PROMPT_AVALIACAO, new RegExp(trecho, 'i'), trecho);
  }
  assert.match(PROMPT_REQUISITOS, /obrigat/i);
  assert.deepEqual(Object.keys(SCHEMA_AVALIACAO.properties).sort(), [...SCHEMA_AVALIACAO.required].sort());
  assert.deepEqual(Object.keys(SCHEMA_REQUISITOS.properties).sort(), [...SCHEMA_REQUISITOS.required].sort());
});
