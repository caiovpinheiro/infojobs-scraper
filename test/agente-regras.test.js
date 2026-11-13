'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RAIO_KM, distanciaKm, descarte, nota, ordenar } = require('../agente/regras');

function aval(extra = {}) {
  return { experiencia: 'relacionada', experiencia_funcao: 'Atendente', experiencia_meses: 12, escolaridade: 'Ensino Médio', curso: null,
    semestre: null, nivel: 'medio', matricula_ativa: null, formado: null, obrigatorios: [], desejaveis: [], observacoes: '', ...extra };
}
const CLT = { tipo: 'CLT', idadeMin: 18, idadeMax: null, aceitaMedioTecnico: null };
const EST = { tipo: 'ESTAGIO', idadeMin: 16, idadeMax: 24, aceitaMedioTecnico: false };

test('raio é 8 km e a distância é haversine', () => {
  assert.equal(RAIO_KM, 8);
  const d = distanciaKm({ lat: -23.5503, lng: -46.6339 }, { lat: -23.5614, lng: -46.6559 });
  assert.ok(d > 2.2 && d < 2.8, String(d));
  assert.equal(distanciaKm({ lat: -23.5, lng: -46.6 }, { lat: -23.5, lng: -46.6 }), 0);
});

test('descartes antes e depois da IA', () => {
  assert.match(descarte(CLT, { idade: 30, distanciaKm: 8.01 }, null), /8 km/);
  assert.equal(descarte(CLT, { idade: 30, distanciaKm: 8 }, null), null);
  assert.match(descarte(CLT, { idade: 17, distanciaKm: 1 }, null), /idade/i);
  assert.equal(descarte(CLT, { idade: null, distanciaKm: 1 }, null), null);
  assert.match(descarte({ ...CLT, idadeMax: 40 }, { idade: 41, distanciaKm: 1 }, null), /idade/i);
  assert.match(descarte(CLT, { idade: 30, distanciaKm: 1 }, aval({ experiencia: 'sem_relacao' })), /experiência/i);
  assert.match(descarte(CLT, { idade: 30, distanciaKm: 1 }, aval({ experiencia: 'nenhuma' })), /experiência/i);
  assert.equal(descarte(CLT, { idade: 30, distanciaKm: 1 }, aval()), null);
  assert.match(descarte(EST, { idade: 20, distanciaKm: 1 }, aval({ formado: true, nivel: 'superior' })), /formad/i);
  assert.match(descarte(EST, { idade: 20, distanciaKm: 1 }, aval({ matricula_ativa: false, nivel: 'superior' })), /matrícula/i);
  assert.match(descarte(EST, { idade: 20, distanciaKm: 1 }, aval({ nivel: 'medio', matricula_ativa: true })), /médio|técnico/i);
  assert.equal(descarte({ ...EST, aceitaMedioTecnico: true }, { idade: 20, distanciaKm: 1 }, aval({ nivel: 'tecnico', matricula_ativa: true, experiencia: 'nenhuma' })), null);
  assert.match(descarte(EST, { idade: 25, distanciaKm: 1 }, null), /idade/i);
});

test('nota segue os pesos do critério', () => {
  const a = aval({ obrigatorios: [
    { requisito: 'r1', situacao: 'atendido' }, { requisito: 'r2', situacao: 'atendido' },
    { requisito: 'r3', situacao: 'nao_atendido' }, { requisito: 'r4', situacao: 'nao_identificado' }] });
  assert.equal(nota(a, 2), 6.5);
  assert.equal(nota(a, 5), 6);
  assert.equal(nota(aval({ experiencia: 'mesma' }), 3), 10);
  assert.equal(nota(aval({ experiencia: 'nenhuma', desejaveis: [{ requisito: 'd', situacao: 'nao_atendido' }, { requisito: 'e', situacao: 'atendido' }] }), 7), 6);
  assert.equal(nota(aval({ obrigatorios: [{ requisito: 'a', situacao: 'atendido' }, { requisito: 'b', situacao: 'atendido' }, { requisito: 'c', situacao: 'nao_atendido' }] }), 1), 7.3);
});

test('ordem: nota, depois 6+ meses, depois distância', () => {
  const item = (id, n, km, meses) => ({ id, nota: n, distanciaKm: km, aval: aval({ experiencia_meses: meses }) });
  const lista = [item('a', 7, 5, 12), item('b', 8, 6, 1), item('c', 7, 2, 3), item('d', 7, 4, 12), item('e', 7, 1, null)];
  assert.deepEqual(ordenar(lista).map(x => x.id), ['b', 'd', 'a', 'e', 'c']);
  assert.equal(lista[0].id, 'a');
});

test('maisPerto escolhe a loja perto de onde a maioria dos inscritos mora', () => {
  const { maisPerto, medianaKm } = require('../agente/regras');
  const mooca = { lat: -23.555, lng: -46.598 };
  const guarulhos = { lat: -23.454, lng: -46.533 };
  const inscritos = [{ lat: -23.46, lng: -46.53 }, { lat: -23.45, lng: -46.54 }, { lat: -23.44, lng: -46.52 }, mooca];
  assert.equal(maisPerto([{ id: 'mooca', ponto: mooca }, { id: 'gru', ponto: guarulhos }], inscritos), 'gru');
  assert.equal(maisPerto([{ id: 'mooca', ponto: mooca }, { id: 'sem', ponto: null }], inscritos), 'mooca');
  assert.equal(maisPerto([{ id: 'a', ponto: mooca }], []), null);
  assert.equal(medianaKm([5, 1, 30, 2]), 3.5);
  assert.equal(medianaKm([]), null);
});
