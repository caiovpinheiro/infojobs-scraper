'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarGeo } = require('../agente/geo');

function resposta(status, corpo) {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo };
}
function fetchFalso(rotas) {
  const chamadas = [];
  const fn = async url => {
    chamadas.push(url);
    for (const [trecho, r] of rotas) if (url.includes(trecho)) return typeof r === 'function' ? r() : r;
    return resposta(404, {});
  };
  fn.chamadas = chamadas;
  return fn;
}
const urls = { awesomeUrl: 'https://awesome.test/json', brasilUrl: 'https://brasil.test/cep/v2' };

test('usa a AwesomeAPI e guarda em cache', async () => {
  const fetch = fetchFalso([['awesome.test/json/01310100', resposta(200, { lat: '-23.5', lng: '-46.6' })]]);
  const geo = criarGeo({ fetch, ...urls });
  assert.deepEqual(await geo.pontoDoCep('01310-100'), { lat: -23.5, lng: -46.6 });
  assert.deepEqual(await geo.pontoDoCep('01310100'), { lat: -23.5, lng: -46.6 });
  assert.equal(fetch.chamadas.length, 1);
});

test('cai para a BrasilAPI e devolve null quando nenhuma acha', async () => {
  const fetch = fetchFalso([
    ['brasil.test/cep/v2/04001000', resposta(200, { location: { coordinates: { latitude: '-23.4', longitude: '-46.5' } } })],
    ['brasil.test/cep/v2/09999999', resposta(200, { location: { coordinates: {} } })]
  ]);
  const geo = criarGeo({ fetch, ...urls });
  assert.deepEqual(await geo.pontoDoCep('04001-000'), { lat: -23.4, lng: -46.5 });
  assert.equal(await geo.pontoDoCep('09999-999'), null);
  const antes = fetch.chamadas.length;
  assert.equal(await geo.pontoDoCep('09999999'), null);
  assert.equal(fetch.chamadas.length, antes);
});

test('CEP inválido e erro de rede não chamam nem quebram', async () => {
  const fetch = fetchFalso([['awesome.test', () => { throw new Error('rede'); }]]);
  const geo = criarGeo({ fetch, ...urls });
  assert.equal(await geo.pontoDoCep('123'), null);
  assert.equal(await geo.pontoDoCep(null), null);
  assert.equal(fetch.chamadas.length, 0);
  assert.equal(await geo.pontoDoCep('01310100'), null);
});
