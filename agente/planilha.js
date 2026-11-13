'use strict';

// Planilha da triagem: aba Resumo + uma aba por vaga do sistema da DNA.

const ExcelJS = require('exceljs');

const COLUNAS = [
  ['Nº', 6], ['Nome', 30], ['Idade', 8], ['Bairro/Cidade', 26], ['Distância (km)', 13], ['Experiência relacionada (função + tempo)', 36],
  ['Escolaridade / Curso e semestre', 32], ['Requisitos atendidos', 40], ['Requisitos não atendidos', 40], ['Nota (0–10)', 11],
  ['Link do perfil no Pandapé', 22], ['Observações', 50]
];
const RESUMO = [
  ['Vaga', 'vaga', 36], ['Tipo', 'tipo', 9], ['CEP', 'cep', 11], ['Vaga(s) Pandapé', 'ligadas', 36], ['Inscritos analisados', 'analisados', 12],
  ['Sem distância', 'semDistancia', 11], ['Descartados', 'descartados', 12], ['Aderentes', 'aderentes', 11], ['Meta 50', 'meta', 9],
  ['Observações', 'observacoes', 70]
];
const LINHA_TITULOS = 9;
const NI = 'não identificado';
const VERDE = 'FFC6EFCE';
const AMARELO = 'FFFFEB9C';

/** Nome de aba válido no Excel (≤31, sem []:*?/\, sem apóstrofo nas pontas) e único, sem diferenciar caixa. */
function nomeDeAba(texto, usados) {
  let base = String(texto || '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').trim();
  if (!base) base = 'Vaga';
  base = base.slice(0, 31).trim().replace(/^'+|'+$/g, '').trim() || 'Vaga';
  if (base.toLowerCase() === 'history') base = 'History (vaga)';
  const ocupado = nome => [...usados].some(u => u.toLowerCase() === nome.toLowerCase());
  let nome = base;
  for (let n = 2; ocupado(nome); n++) nome = `${base.slice(0, 31 - String(n).length - 1).trim().replace(/'+$/, '')} ${n}`;
  usados.add(nome);
  return nome;
}

function titulo(celula) {
  celula.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  celula.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153F68' } };
  celula.alignment = { vertical: 'middle', wrapText: true };
}

function abaResumo(wb, linhas) {
  const ws = wb.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = RESUMO.map(([cabecalho, chave, largura]) => ({ header: cabecalho, key: chave, width: largura }));
  ws.getRow(1).eachCell(titulo);
  for (const linha of linhas) ws.addRow({ ...linha, meta: linha.meta ? 'sim' : 'não' }).alignment = { vertical: 'top', wrapText: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, linhas.length + 1), column: RESUMO.length } };
}

function abaVaga(wb, aba, usados) {
  const { vaga, requisitos, candidatos } = aba;
  const nome = nomeDeAba(`${vaga.cargo} ${vaga.local || vaga.empresa || ''}`, usados);
  const ws = wb.addWorksheet(nome, { views: [{ state: 'frozen', ySplit: LINHA_TITULOS }] });
  ws.columns = COLUNAS.map(([, largura]) => ({ width: largura }));
  const cabecalho = [
    ['ID da vaga', vaga.vagaId || vaga.id], ['Loja', [vaga.empresa, vaga.local].filter(Boolean).join(' – ') || NI],
    ['Cargo', vaga.cargo], ['Tipo', vaga.tipo === 'ESTAGIO' ? 'Estágio' : 'CLT'], ['CEP', vaga.cep || NI],
    ['Requisitos obrigatórios', (requisitos?.obrigatorios || []).join('; ') || NI],
    ['Requisitos desejáveis', (requisitos?.desejaveis || []).join('; ') || 'nenhum informado']
  ];
  cabecalho.forEach(([rotulo, valor], i) => {
    const row = ws.getRow(i + 1);
    row.getCell(1).value = rotulo;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = valor;
    ws.mergeCells(i + 1, 2, i + 1, COLUNAS.length);
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  });
  const titulos = ws.getRow(LINHA_TITULOS);
  COLUNAS.forEach(([texto], i) => { titulos.getCell(i + 1).value = texto; titulo(titulos.getCell(i + 1)); });
  titulos.height = 32;
  candidatos.forEach((c, i) => {
    const row = ws.getRow(LINHA_TITULOS + 1 + i);
    row.values = [i + 1, c.nome || NI, c.idade || NI, c.bairro || NI, c.distanciaKm, c.experiencia || NI, c.escolaridade || NI,
      c.atendidos || NI, c.naoAtendidos || '—', c.nota, c.link ? { text: 'Abrir perfil', hyperlink: c.link } : NI, c.observacoes || ''];
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(5).numFmt = '0.0';
    row.getCell(10).numFmt = '0.0';
    if (c.link) row.getCell(11).font = { color: { argb: 'FF17699F' }, underline: true };
  });
  const ultima = LINHA_TITULOS + Math.max(1, candidatos.length);
  ws.autoFilter = { from: { row: LINHA_TITULOS, column: 1 }, to: { row: ultima, column: COLUNAS.length } };
  ws.addConditionalFormatting({
    ref: `J${LINHA_TITULOS + 1}:J${ultima}`,
    rules: [
      { type: 'cellIs', operator: 'greaterThanOrEqual', formulae: ['8'], priority: 1, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: VERDE } } } },
      { type: 'cellIs', operator: 'between', formulae: ['5', '7.9999'], priority: 2, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: AMARELO } } } }
    ]
  });
}

async function montarPlanilha(resultado) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Painel Pandapé – agente de triagem';
  wb.created = resultado.geradoEm || new Date();
  abaResumo(wb, resultado.resumo || []);
  const usados = new Set(['Resumo']);
  for (const aba of resultado.abas || []) abaVaga(wb, aba, usados);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { montarPlanilha, nomeDeAba };
