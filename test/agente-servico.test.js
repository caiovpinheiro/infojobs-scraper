'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarServicoAgente } = require('../agente/servico');

test('final: dois pedidos ao mesmo tempo iniciam só uma análise', async () => {
  let liberar;
  const espera = new Promise(resolve => { liberar = resolve; });
  const pool = { async query() { await espera; return { rows: [] }; } };
  const snapshots = new Map([['s', { expiresAt: Date.now() + 60000, vacancies: [{ id: '10', title: 'Caixa', type: 'CLT' }], candidates: [] }]]);
  const servico = criarServicoAgente({ env: { OPENAI_API_KEY: 'k', DATABASE_URL: 'x' }, obterPool: () => pool, erroDoBanco: () => '', snapshots,
    pandapeGet: async () => '', pandapeBase: 'https://p', maxCandidates: 500 });
  const pedido = { snapshotId: 's', ligacoes: [{ idVacancy: '10', vagaDnaId: '55' }] };
  const primeiro = servico.iniciar(pedido);
  const segundo = servico.iniciar(pedido);
  liberar();
  const resultados = await Promise.allSettled([primeiro, segundo]);
  assert.equal(resultados.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1);
});

test('ligação: entre lojas com o mesmo cargo, fica a mais perto dos inscritos', async () => {
  const vagas = [
    { id: 'mooca', tipo: 'CLT', cargo: 'Operador de Caixa', empresa: 'Rede', local: 'Mooca', lat: -23.555, lng: -46.598, cep: '03101000' },
    { id: 'gru', tipo: 'CLT', cargo: 'Operador de Caixa', empresa: 'Rede', local: 'Bonsucesso', lat: -23.454, lng: -46.533, cep: '07175000' }
  ];
  const pontos = { '07100001': { lat: -23.46, lng: -46.53 }, '07100002': { lat: -23.45, lng: -46.54 }, '07100003': { lat: -23.44, lng: -46.52 } };
  const snapshots = new Map([['s', { expiresAt: Date.now() + 60000, vacancies: [{ id: '10', title: 'Operador de caixa', type: 'CLT', total: 3 }],
    candidates: ['07100001', '07100002', '07100003'].map((cep, i) => ({ key: `10:${i}`, idVacancy: '10', cep })) }]]);
  const servico = criarServicoAgente({ env: { OPENAI_API_KEY: 'k', NODE_ENV: 'test', AGENTE_VAGAS_TESTE_JSON: JSON.stringify(vagas) }, obterPool: () => null, erroDoBanco: () => '',
    snapshots, pandapeGet: async () => '', pandapeBase: 'https://p', maxCandidates: 500, geo: { pontoDoCep: async cep => pontos[String(cep).replace(/\D/g, '')] || null } });
  const r = await servico.vagas('s');
  assert.equal(r.vagasPandape[0].sugestao, 'gru');
});
