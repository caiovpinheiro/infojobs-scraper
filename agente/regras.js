'use strict';

// Regras decisivas do agente: o código decide distância, descarte, nota e ordem. A IA só interpreta o texto.

const RAIO_KM = 8;

function distanciaKm(a, b) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Motivo do descarte, ou null. Sem `aval` (antes da IA) confere só distância e idade.
 * regra = { tipo: 'CLT'|'ESTAGIO', idadeMin, idadeMax, aceitaMedioTecnico }.
 */
function descarte(regra, candidato, aval) {
  if (typeof candidato.distanciaKm === 'number' && candidato.distanciaKm > RAIO_KM) return `mora a mais de ${RAIO_KM} km`;
  const idade = Number.isInteger(candidato.idade) ? candidato.idade : null;
  if (idade !== null && Number.isInteger(regra.idadeMin) && idade < regra.idadeMin) return `idade ${idade} abaixo de ${regra.idadeMin}`;
  if (idade !== null && Number.isInteger(regra.idadeMax) && idade > regra.idadeMax) return `idade ${idade} acima de ${regra.idadeMax}`;
  if (!aval) return null;
  if (regra.tipo === 'CLT') {
    if (aval.experiencia !== 'mesma' && aval.experiencia !== 'relacionada') return 'sem experiência relacionada à vaga';
    return null;
  }
  if (aval.formado === true) return 'já formado (estágio exige matrícula ativa)';
  if (aval.matricula_ativa === false) return 'sem matrícula ativa';
  if ((aval.nivel === 'medio' || aval.nivel === 'tecnico') && regra.aceitaMedioTecnico === false) return 'ensino médio/técnico, que a vaga não aceita';
  return null;
}

function proporcao(lista, vazio) {
  if (!Array.isArray(lista) || !lista.length) return vazio;
  return lista.filter(item => item.situacao === 'atendido').length / lista.length;
}

/** Nota de 0 a 10, uma casa decimal. */
function nota(aval, km) {
  const obrigatorios = 5 * proporcao(aval.obrigatorios, 1);
  const experiencia = aval.experiencia === 'mesma' ? 3 : aval.experiencia === 'relacionada' ? 2 : 0;
  const distancia = km <= 3 ? 1 : km <= RAIO_KM ? 0.5 : 0;
  const desejaveis = proporcao(aval.desejaveis, 1);
  return Math.round((obrigatorios + experiencia + distancia + desejaveis) * 10) / 10;
}

function seisMeses(item) {
  return Number.isInteger(item.aval?.experiencia_meses) && item.aval.experiencia_meses >= 6 ? 1 : 0;
}

/** Nota desc; empate: 6+ meses na área primeiro; depois a menor distância. Não altera a lista original. */
function ordenar(lista) {
  return [...lista].sort((a, b) => (b.nota - a.nota) || (seisMeses(b) - seisMeses(a)) || (a.distanciaKm - b.distanciaKm));
}

module.exports = { RAIO_KM, distanciaKm, descarte, nota, ordenar };
