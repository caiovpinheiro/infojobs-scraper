'use strict';

// Cliente da Luna (OpenAI Responses API). Nunca registra em log o texto enviado nem a resposta.

const { PROMPT_REQUISITOS, PROMPT_AVALIACAO, SCHEMA_REQUISITOS, SCHEMA_AVALIACAO } = require('./prompts');

function erroIa(codigo, mensagem) {
  return Object.assign(new Error(`${codigo}: ${mensagem}`), { code: codigo });
}

function textoDaResposta(corpo) {
  const partes = [];
  for (const item of Array.isArray(corpo?.output) ? corpo.output : []) {
    for (const parte of Array.isArray(item?.content) ? item.content : []) {
      if (parte?.type === 'output_text' && typeof parte.text === 'string') partes.push(parte.text);
    }
  }
  return partes.join('').trim() || (typeof corpo?.output_text === 'string' ? corpo.output_text.trim() : '');
}

function lerJson(texto) {
  const limpo = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(limpo); } catch { /* tenta o primeiro objeto */ }
  const inicio = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  if (inicio >= 0 && fim > inicio) {
    try { return JSON.parse(limpo.slice(inicio, fim + 1)); } catch { /* inválido */ }
  }
  return null;
}

/** Confere o objeto contra o schema (subconjunto usado aqui: object, array, enum, tipos com null). */
function confere(valor, schema) {
  const tipos = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (valor === null) return tipos.includes('null');
  if (schema.enum && !schema.enum.includes(valor)) return false;
  if (Array.isArray(valor)) return tipos.includes('array') && valor.every(item => confere(item, schema.items));
  if (typeof valor === 'object') {
    if (!tipos.includes('object')) return false;
    return schema.required.every(chave => Object.hasOwn(valor, chave) && confere(valor[chave], schema.properties[chave]));
  }
  if (typeof valor === 'number') return tipos.includes('integer') ? Number.isInteger(valor) : tipos.includes('number');
  return tipos.includes(typeof valor);
}

function criarIa({ fetch = globalThis.fetch, url = 'https://api.openai.com/v1', key = '', model = 'gpt-6-luna', timeoutMs = 60000, esperaMs = 2000 } = {}) {
  const base = String(url || 'https://api.openai.com/v1').replace(/\/+$/, '');

  async function chamar(instrucoes, texto, nome, schema, estruturado) {
    const corpo = {
      model, store: false, instructions: instrucoes,
      input: [{ role: 'user', content: [{ type: 'input_text', text: estruturado ? texto : `${texto}\n\nResponda só com JSON neste formato (JSON Schema): ${JSON.stringify(schema)}` }] }]
    };
    if (estruturado) corpo.text = { format: { type: 'json_schema', name: nome, strict: true, schema } };
    let resposta;
    try {
      resposta = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch { return { falhaTemporaria: true }; }
    const bruto = await resposta.text().catch(() => '');
    if (resposta.status === 400 && estruturado) return { semSchema: true };
    if (resposta.status === 429 || resposta.status >= 500) return { falhaTemporaria: true };
    if (!resposta.ok) throw erroIa('IA_ERRO', `OpenAI respondeu HTTP ${resposta.status}.`);
    let json;
    try { json = JSON.parse(bruto); } catch { throw erroIa('IA_FORMATO', 'resposta da OpenAI não é JSON.'); }
    const objeto = lerJson(textoDaResposta(json));
    if (!objeto || !confere(objeto, schema)) throw erroIa('IA_FORMATO', 'a IA respondeu fora do formato esperado.');
    return { objeto };
  }

  async function pedir(instrucoes, texto, nome, schema) {
    if (!key) throw erroIa('IA_INDISPONIVEL', 'configure OPENAI_API_KEY.');
    let estruturado = true;
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const r = await chamar(instrucoes, texto, nome, schema, estruturado);
      if (r.objeto) return r.objeto;
      if (r.semSchema) { estruturado = false; continue; }
      if (tentativa >= 1) break;
      await new Promise(resolve => setTimeout(resolve, esperaMs));
    }
    throw erroIa('IA_INDISPONIVEL', 'a OpenAI não respondeu a tempo.');
  }

  return {
    pronta: Boolean(key),
    requisitosDaVaga(vagaTexto) {
      return pedir(PROMPT_REQUISITOS, `VAGA:\n${vagaTexto}`, 'requisitos_vaga', SCHEMA_REQUISITOS);
    },
    avaliar(vagaTexto, requisitos, perfil) {
      const texto = `VAGA:\n${vagaTexto}\n\nREQUISITOS DA VAGA:\n${JSON.stringify({ obrigatorios: requisitos?.obrigatorios || [], desejaveis: requisitos?.desejaveis || [] })}\n\nCURRÍCULO DO CANDIDATO:\n${perfil}`;
      return pedir(PROMPT_AVALIACAO, texto, 'avaliacao_candidato', SCHEMA_AVALIACAO);
    }
  };
}

module.exports = { criarIa, textoDaResposta, confere };
