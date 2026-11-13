'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizar, perfilDoHtml, horarioTexto, sugerirLigacoes } = require('../agente/texto');

const PERFIL = `
<div class="header"><h3>Fulano da Silva</h3><span>+55-11999998888</span><a>x@y.com</a></div>
<div id="ResumeProfile" class="resume-item"><div>Perfil e objetivos</div><p>Resumo</p><p>Busco vaga em loja. Contato: fulano@mail.com ou (11) 98888-7777.</p>
<p>CV em anexo</p><p>Fulano_Silva.pdf</p></div>
<div id="ResumeExperiences"><div>Experiência</div><span>Mar 2026 -</span><span>Out 2026</span><span>(7 meses)</span>
<strong>Auxiliar de Cobran&#xE7;a</strong><span>Empresa X, Brasil</span><script>var x = 1;</script></div>
<div id="ResumeStudies"><div>Formação</div><span>Cursando</span><strong>Gest&atilde;o de RH</strong></div>
<div id="ResumePersonalInformationContainer"><div>Dados pessoais e de contato</div><span class="js_CandidateAddressCP">CEP 01310-100</span></div>`;

test('perfilDoHtml recorta o currículo e tira dados de contato', () => {
  const texto = perfilDoHtml(PERFIL);
  assert.match(texto, /Auxiliar de Cobrança/);
  assert.match(texto, /7 meses/);
  assert.match(texto, /Cursando/);
  assert.match(texto, /Gestão de RH/);
  for (const proibido of ['x@y.com', 'fulano@mail.com', '99999', '98888', 'Fulano_Silva.pdf', 'CEP', '01310', 'Fulano da Silva', 'var x']) {
    assert.equal(texto.includes(proibido), false, proibido);
  }
});

test('perfilDoHtml não deixa pedaço de tag no fim', () => {
  assert.equal(perfilDoHtml('<div id="ResumeProfile">perfil-1</div><div id="ResumePersonalInformationContainer">'), 'perfil-1');
});

test('perfilDoHtml devolve null sem o bloco do currículo', () => {
  assert.equal(perfilDoHtml('<html><body>Erro</body></html>'), null);
  assert.equal(perfilDoHtml(''), null);
});

test('horarioTexto lê texto livre e grade por dia', () => {
  assert.equal(horarioTexto('2=08:00-17:00;3=08:00-17:00;4=08:00-17:00;5=08:00-17:00;6=08:00-17:00'), 'segunda a sexta, 08:00 às 17:00');
  assert.equal(horarioTexto('texto=12x36 noturno'), '12x36 noturno');
  assert.equal(horarioTexto('2=08:00-12:00;7=09:00-13:00;1=10:00-14:00'), 'segunda, 08:00 às 12:00; sábado, 09:00 às 13:00; domingo, 10:00 às 14:00');
  assert.equal(horarioTexto(''), null);
  assert.equal(horarioTexto(null), null);
});

test('normalizar tira acento, caixa e pontuação', () => {
  assert.equal(normalizar('  Operador(a) de CAIXA – Mooca!  '), 'operador a de caixa mooca');
});

test('sugerirLigacoes liga pelo cargo e respeita o tipo', () => {
  const dna = [
    { id: 'a', cargo: 'Operador de Caixa', tipo: 'CLT', local: 'Mooca', empresa: 'Loja X' },
    { id: 'c', cargo: 'Operador de Caixa', tipo: 'CLT', local: 'Pinheiros', empresa: 'Loja Y' },
    { id: 'b', cargo: 'Repositor', tipo: 'CLT', local: 'Centro' },
    { id: 'e', cargo: 'Estágio em Recursos Humanos', tipo: 'ESTAGIO', local: 'Centro' }
  ];
  const ligacoes = sugerirLigacoes([
    { id: '1', title: 'Operador de Caixa - Mooca', type: 'CLT' },
    { id: '2', title: 'Motorista de caminhão', type: 'CLT' },
    { id: '3', title: 'Estágio em Recursos Humanos', type: 'CLT' },
    { id: '4', title: 'Estágio em Recursos Humanos', type: null }
  ], dna);
  assert.deepEqual(ligacoes, { 1: 'a', 2: null, 3: null, 4: 'e' });
});
