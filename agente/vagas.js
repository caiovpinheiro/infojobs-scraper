'use strict';

// Vagas abertas do sistema da DNA (Postgres do DATABASE_URL). Só leitura.
// public.vaga só guarda as abertas: o sync do sistema da DNA tira as fechadas.

const { horarioTexto } = require('./texto');

const COMPLETA = `
  SELECT v.id::text AS id, v.vaga_id::text AS vaga_id, v.tipo_vaga, v.cargo, v.salario::text AS salario, v.beneficios,
         v.idade, v.idade_ate, v.horario, v.carga_horaria::text AS carga_horaria, v.escolaridade::text AS escolaridade,
         v.atividades, COALESCE(NULLIF(v.descricao, ''), c.descricao) AS descricao,
         COALESCE(NULLIF(v.requisitos, ''), c.requisitos) AS requisitos,
         v.cep, v.latitude, v.longitude, e.nome_fantasia, e.local
  FROM public.vaga v
  LEFT JOIN public.empresa e ON e.id = v.empresa_id
  LEFT JOIN public.cargo c ON c.id = v.cargo_id
  WHERE v.tipo_vaga IN (1, 2)
  ORDER BY v.cargo, e.nome_fantasia`;
const BASICA = `
  SELECT v.id::text AS id, v.vaga_id::text AS vaga_id, v.tipo_vaga, v.cargo, v.salario::text AS salario, v.beneficios,
         v.idade, v.idade_ate, v.horario, v.carga_horaria::text AS carga_horaria, v.escolaridade::text AS escolaridade,
         v.atividades, NULL::text AS descricao, NULL::text AS requisitos,
         v.cep, v.latitude, v.longitude, e.nome_fantasia, e.local
  FROM public.vaga v
  LEFT JOIN public.empresa e ON e.id = v.empresa_id
  WHERE v.tipo_vaga IN (1, 2)
  ORDER BY v.cargo, e.nome_fantasia`;

function texto(valor) {
  const t = valor === null || valor === undefined ? '' : String(valor).trim();
  return t || null;
}
function inteiroPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function coordenadas(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  const valido = lat !== null && lng !== null && Number.isFinite(a) && Number.isFinite(b) && a !== 0 && b !== 0 && Math.abs(a) <= 90 && Math.abs(b) <= 180;
  return valido ? { lat: a, lng: b } : { lat: null, lng: null };
}

async function nomesDeEscolaridade(pool, codigos) {
  const numericos = [...new Set(codigos.filter(codigo => /^\d+$/.test(codigo || '')))];
  if (!numericos.length) return new Map();
  try {
    const { rows } = await pool.query('SELECT id_flex::text AS id, valor FROM dna_work.flex WHERE id_flex::text = ANY($1::text[])', [numericos]);
    return new Map(rows.filter(row => texto(row.valor)).map(row => [String(row.id), String(row.valor).trim()]));
  } catch { return new Map(); }
}

async function listarVagasDna(pool) {
  let rows;
  try { rows = (await pool.query(COMPLETA)).rows; }
  catch (error) {
    if (error.code !== '42703' && error.code !== '42P01') throw error;
    rows = (await pool.query(BASICA)).rows;
  }
  const escolaridades = await nomesDeEscolaridade(pool, rows.map(row => row.escolaridade));
  return rows.map(row => ({
    id: String(row.id),
    vagaId: texto(row.vaga_id),
    tipo: Number(row.tipo_vaga) === 1 ? 'ESTAGIO' : 'CLT',
    cargo: texto(row.cargo) || 'Vaga sem cargo',
    salario: texto(row.salario),
    beneficios: texto(row.beneficios),
    idade: inteiroPositivo(row.idade),
    idadeAte: inteiroPositivo(row.idade_ate),
    horario: horarioTexto(row.horario),
    cargaHoraria: texto(row.carga_horaria),
    escolaridade: escolaridades.get(String(row.escolaridade)) || (/^\d+$/.test(row.escolaridade || '') ? null : texto(row.escolaridade)),
    atividades: texto(row.atividades),
    descricao: texto(row.descricao),
    requisitos: texto(row.requisitos),
    cep: texto(row.cep),
    ...coordenadas(row.latitude, row.longitude),
    empresa: texto(row.nome_fantasia),
    local: texto(row.local)
  }));
}

/** O que vai para a IA sobre a vaga. Sem empresa, endereço nem CEP. */
function textoDaVaga(vaga) {
  const salario = Number(vaga.salario) > 0 ? `R$ ${Number(vaga.salario).toFixed(2).replace('.', ',')}` : null;
  const linhas = [
    ['Cargo', vaga.cargo],
    ['Tipo', vaga.tipo === 'ESTAGIO' ? 'Estágio' : 'CLT'],
    ['Escolaridade', vaga.escolaridade],
    ['Idade', vaga.idade || vaga.idadeAte ? `${vaga.idade ? `a partir de ${vaga.idade}` : ''}${vaga.idade && vaga.idadeAte ? ' ' : ''}${vaga.idadeAte ? `até ${vaga.idadeAte}` : ''} anos` : null],
    ['Horário', vaga.horario],
    ['Carga horária', vaga.cargaHoraria],
    [vaga.tipo === 'ESTAGIO' ? 'Bolsa' : 'Salário', salario],
    ['Benefícios', vaga.beneficios],
    ['Atividades', vaga.atividades],
    ['Descrição', vaga.descricao],
    ['Requisitos', vaga.requisitos]
  ];
  return linhas.filter(([, valor]) => valor).map(([rotulo, valor]) => `${rotulo}: ${valor}`).join('\n');
}

module.exports = { listarVagasDna, textoDaVaga };
