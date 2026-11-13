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
