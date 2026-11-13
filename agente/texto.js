'use strict';

// Funções puras do agente: texto do perfil do Pandapé, horário da vaga e sugestão de ligação de vagas.

const LETRAS = { a: 'a', e: 'e', i: 'i', o: 'o', u: 'u', c: 'c', n: 'n' };
const ACENTOS = { acute: '́', grave: '̀', circ: '̂', tilde: '̃', cedil: '̧', uml: '̈' };
const NOMEADAS = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ordm: 'º', ordf: 'ª', ndash: '–', mdash: '—', bull: '•' };

function entidade(nome) {
  if (Object.hasOwn(NOMEADAS, nome)) return NOMEADAS[nome];
  const m = /^([a-zA-Z])(acute|grave|circ|tilde|cedil|uml)$/.exec(nome);
  if (m && Object.hasOwn(LETRAS, m[1].toLowerCase())) return (m[1] + ACENTOS[m[2]]).normalize('NFC');
  return null;
}
function decodificar(texto) {
  return String(texto || '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (inteira, corpo) => {
    if (corpo[0] === '#') {
      const n = corpo[1].toLowerCase() === 'x' ? parseInt(corpo.slice(2), 16) : parseInt(corpo.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : inteira;
    }
    return entidade(corpo) ?? inteira;
  });
}

function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const LIMITE_PERFIL = 12000;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const TELEFONE = /(?:\+?55[\s-]*)?\(?\d{2}\)?[\s-]*9?\d{4}[\s-]?\d{4}\b/g;
const CEP = /\b\d{5}-?\d{3}\b|\bCEP\b/gi;
const ARQUIVO = /\S+\.(?:pdf|docx?|odt|rtf|png|jpe?g)\b/gi;

/** Trecho do currículo (de ResumeProfile até os dados pessoais), sem tags e sem contato. Null se o formato não bater. */
function perfilDoHtml(html) {
  const texto = String(html || '');
  const inicio = texto.search(/id="ResumeProfile"/);
  if (inicio < 0) return null;
  const resto = texto.slice(inicio);
  const fim = resto.search(/id="ResumePersonalInformationContainer"|id="ResumeContactData"/);
  // Corta no "<" da tag que tem o id do fim, não no id (senão sobra "<div ").
  const corte = fim >= 0 ? resto.lastIndexOf('<', fim) : -1;
  let trecho = (fim >= 0 ? resto.slice(0, corte >= 0 ? corte : fim) : resto).replace(/^[^>]*>/, '');
  trecho = trecho.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h\d|tr|strong|span)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  trecho = decodificar(trecho)
    .replace(EMAIL, ' ').replace(ARQUIVO, ' ').replace(TELEFONE, ' ').replace(CEP, ' ');
  const linhas = trecho.split(/\n/).map(linha => linha.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const final = linhas.join('\n').slice(0, LIMITE_PERFIL).trim();
  return final || null;
}

const DIAS = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];

/** public.vaga.horario: "texto=…" ou grade "1=HH:MM-HH:MM;…" (1 = domingo … 7 = sábado). */
function horarioTexto(horario) {
  const bruto = String(horario ?? '');
  const livre = bruto.match(/(?:^|;)texto=([\s\S]*)$/)?.[1]?.trim();
  if (livre) return livre;
  const porDia = new Map();
  for (const [, dia, entrada, saida] of bruto.matchAll(/(?:^|;)([1-7])=(\d{2}:\d{2})-(\d{2}:\d{2})/g)) {
    porDia.set(Number(dia), `${entrada} às ${saida}`);
  }
  if (!porDia.size) return null;
  const faixas = DIAS.map((_, i) => porDia.get(i === 6 ? 1 : i + 2) || null);
  const partes = [];
  let i = 0;
  while (i < 7) {
    if (!faixas[i]) { i++; continue; }
    let j = i;
    while (j + 1 < 7 && faixas[j + 1] === faixas[i]) j++;
    const nome = i === j ? DIAS[i] : `${DIAS[i]} ${j - i === 1 ? 'e' : 'a'} ${DIAS[j]}`;
    partes.push(`${nome}, ${faixas[i]}`);
    i = j + 1;
  }
  return partes.join('; ');
}

const VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'as', 'os', 'para', 'com', 'na', 'no', 'vaga', 'clt', 'loja']);
function palavras(texto) {
  return new Set(normalizar(texto).split(' ').filter(p => p.length > 1 && !VAZIAS.has(p)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let comum = 0;
  for (const p of a) if (b.has(p)) comum++;
  return comum / (a.size + b.size - comum);
}
const SEMELHANCA_MINIMA = 0.34;

/** Para cada vaga do Pandapé, o id da vaga DNA mais parecida do mesmo tipo, ou null. */
function sugerirLigacoes(vagasPandape, vagasDna) {
  const resultado = {};
  for (const vaga of vagasPandape) {
    const titulo = palavras(vaga.title);
    let melhor = null;
    let melhorNota = 0;
    for (const dna of vagasDna) {
      if (vaga.type && dna.tipo !== vaga.type) continue;
      const base = jaccard(titulo, palavras(dna.cargo));
      if (base < SEMELHANCA_MINIMA) continue;
      const lugar = palavras(`${dna.local || ''} ${dna.empresa || ''}`);
      let extra = 0;
      for (const p of titulo) if (lugar.has(p)) extra += 0.01;
      if (base + extra > melhorNota) { melhorNota = base + extra; melhor = dna.id; }
    }
    resultado[vaga.id] = melhor;
  }
  return resultado;
}

module.exports = { normalizar, decodificar, perfilDoHtml, horarioTexto, sugerirLigacoes };
