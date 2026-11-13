'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const ExcelJS = require('exceljs');

// Servidor falso: Pandapé, serviço de login, CRM, OpenAI e geocodificador.
const calls = [];
let fake;
let base;

const AVAL = { experiencia: 'mesma', experiencia_funcao: 'Operador de Caixa', experiencia_meses: 12, escolaridade: 'Ensino Médio completo', curso: null,
  semestre: null, nivel: 'medio', matricula_ativa: null, formado: null, obrigatorios: [{ requisito: 'Experiência em caixa', situacao: 'atendido' }],
  desejaveis: [], observacoes: '' };
const REQ = { obrigatorios: ['Experiência em caixa'], desejaveis: [], idade_min: null, idade_max: null, aceita_medio_tecnico: null, interpretacoes: [] };
const VAGAS_TESTE = [{ id: '55', vagaId: '1203', tipo: 'CLT', cargo: 'Operador de Caixa', cep: '01310-100', lat: -23.5614, lng: -46.6559,
  empresa: 'Loja X', local: 'Bela Vista', idade: null, idadeAte: null, requisitos: 'Experiência em caixa.' }];

function responder(res, status, corpo, tipo = 'application/json') {
  res.writeHead(status, { 'Content-Type': tipo });
  res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
}

before(async () => {
  fake = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, path: url.pathname, search: url.search, body });
      if (url.pathname === '/cookie') return responder(res, 200, { cookie: 'ats-webui=x', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/pipelines') return responder(res, 200, [{ id: 'pipe', name: 'Candidaturas', stages: [{ id: 'etapa', name: 'Lead' }] }]);
      if (url.pathname === '/Company/Vacancy/ListVacancies') {
        return responder(res, 200, '<a class="font-xl fw-900 lh-120" href="/Company/Match/Matches/10?idvacancyfolder=1"><span class="text-capitalize-first">Operador de Caixa Paulista</span></a><span class="js_tagText">#CLT</span>', 'text/html');
      }
      if (url.pathname === '/Company/Match/Matches/10' && !url.searchParams.get('idMatch')) {
        return responder(res, 200, '<input id="hdnVacancyName" value="Operador de Caixa Paulista"><a href="/Company/Match/Matches/10?idvacancyfolder=77" title="Inscritos">Inscritos</a>', 'text/html');
      }
      if (url.pathname === '/Company/Match/Matches/10') {
        const id = url.searchParams.get('idMatch');
        return responder(res, 200, `<a href="https://wa.me/551198888000${id}">zap</a><span class="js_CandidateAddressCP"> CEP 01310-100</span>
          <span class="js_CandidateAddress">Bela Vista, São Paulo, SP</span><span>Nasceu em 10 de março de 2000</span>
          <div id="ResumeProfile">Resumo</div><div id="ResumeExperiences">Operador de Caixa (1 ano)</div>
          <div id="ResumePersonalInformationContainer">dados</div>`, 'text/html');
      }
      if (url.pathname === '/Company/Match/ListMatches') {
        return responder(res, 200, { total: 2, viewList: '<a href="?idMatch=1" data-username="Ana">x</a><a href="?idMatch=2" data-username="Bia">x</a>' });
      }
      if (url.pathname === '/v1/responses') {
        const pedido = JSON.parse(body);
        const objeto = pedido.text.format.name === 'requisitos_vaga' ? REQ : AVAL;
        return responder(res, 200, { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(objeto) }] }] });
      }
      if (url.pathname.startsWith('/geo/')) return responder(res, 200, { lat: '-23.5614', lng: '-46.6559' });
      return responder(res, 404, { message: 'nao encontrado' });
    });
  });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  base = `http://127.0.0.1:${fake.address().port}`;
});
after(async () => { if (fake) await new Promise(resolve => fake.close(resolve)); });

async function iniciar(extra = {}) {
  const env = { ...process.env, NODE_ENV: 'test', PORT: '0', PANDAPE_LOGIN_URL: base, PANDAPE_LOGIN_TOKEN: 't', PANDAPE_BASE_URL: base,
    CRM_BASE_URL: base, CRM_API_KEY: 'crm', CRM_STAGE_ID: 'etapa', VACANCY_TYPES_JSON: '{}', DATABASE_URL: '',
    OPENAI_API_KEY: 'sk-test', OPENAI_API_URL: `${base}/v1`, GEO_AWESOME_URL: `${base}/geo`, GEO_BRASILAPI_URL: `${base}/geo2`,
    AGENTE_VAGAS_TESTE_JSON: JSON.stringify(VAGAS_TESTE), ...extra };
  delete env.APP_USER;
  delete env.APP_PASSWORD;
  for (const [chave, valor] of Object.entries(extra)) if (valor === undefined) delete env[chave];
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const porta = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(log || 'servidor não iniciou')), 5000);
    child.stdout.on('data', () => { const m = log.match(/porta (\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`saiu ${code}: ${log}`)); });
  });
  return { child, url: `http://127.0.0.1:${porta}`, log: () => log };
}
async function esperar(url, chave = 'status') {
  for (let i = 0; i < 100; i++) {
    const job = await (await fetch(url)).json();
    if (job[chave] !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('job não terminou');
}

test('sem login: busca, liga, roda o agente e baixa a planilha', async () => {
  const app = await iniciar();
  try {
    const status = await (await fetch(`${app.url}/api/agente/status`)).json();
    assert.equal(status.pronto, true, status.motivo);

    const logo = await fetch(`${app.url}/logo-laranja.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${app.url}/favicon-32x32.png`)).status, 200);
    assert.equal((await fetch(`${app.url}/../server.js`)).status, 404);
    const pagina = await fetch(`${app.url}/`);
    assert.match(pagina.headers.get('content-security-policy'), /fonts\.gstatic\.com/);

    const preview = await fetch(`${app.url}/api/preview`, { method: 'POST', body: '{"maxVacancies":5}' });
    assert.equal(preview.status, 202);
    const job = await esperar(`${app.url}/api/preview/${(await preview.json()).jobId}`);
    assert.equal(job.status, 'completed', job.error);
    const snapshotId = job.result.snapshotId;

    const vagas = await (await fetch(`${app.url}/api/agente/vagas?snapshot=${snapshotId}`)).json();
    assert.equal(vagas.vagasDna[0].id, '55');
    assert.match(vagas.vagasDna[0].rotulo, /Operador de Caixa – Loja X/);
    assert.equal(vagas.vagasPandape[0].id, '10');
    assert.equal(vagas.vagasPandape[0].sugestao, '55');

    const ruim = await fetch(`${app.url}/api/agente`, { method: 'POST', body: JSON.stringify({ snapshotId, ligacoes: [] }) });
    assert.equal(ruim.status, 400);

    const inicio = await fetch(`${app.url}/api/agente`, { method: 'POST', body: JSON.stringify({ snapshotId, ligacoes: [{ idVacancy: '10', vagaDnaId: '55' }] }) });
    assert.equal(inicio.status, 202);
    const { jobId } = await inicio.json();
    const fim = await esperar(`${app.url}/api/agente/${jobId}`);
    assert.equal(fim.status, 'completed', fim.error);
    assert.equal(fim.feitos, fim.total);
    assert.equal(fim.resumo[0].aderentes, 2);

    const planilha = await fetch(`${app.url}/api/agente/${jobId}/planilha`);
    assert.equal(planilha.status, 200);
    assert.match(planilha.headers.get('content-type'), /spreadsheetml/);
    assert.match(planilha.headers.get('content-disposition'), /attachment; filename="triagem-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx"/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await planilha.arrayBuffer()));
    assert.deepEqual(wb.worksheets.map(ws => ws.name).slice(0, 1), ['Resumo']);
    assert.equal(wb.worksheets[1].getCell('B10').value, 'Ana');

    const respostas = calls.filter(c => c.path === '/v1/responses').map(c => c.body).join('\n');
    assert.equal(/5511988880001|Bela Vista|01310/.test(respostas), false, 'contato e endereço não vão para a OpenAI');
    assert.equal(calls.some(c => c.method === 'POST' && (c.path.startsWith('/contacts') || c.path.startsWith('/deals'))), false);
    assert.equal((await fetch(`${app.url}/api/agente/00000000-0000-0000-0000-000000000000/planilha`)).status, 404);
  } finally {
    app.child.kill('SIGTERM');
    await once(app.child, 'exit');
  }
});

test('sem OPENAI_API_KEY o agente fica indisponível e o painel funciona', async () => {
  const app = await iniciar({ OPENAI_API_KEY: '' });
  try {
    const status = await (await fetch(`${app.url}/api/agente/status`)).json();
    assert.equal(status.pronto, false);
    assert.match(status.motivo, /OPENAI_API_KEY/);
    const inicio = await fetch(`${app.url}/api/agente`, { method: 'POST', body: JSON.stringify({ snapshotId: '00000000-0000-0000-0000-000000000000', ligacoes: [{ idVacancy: '10', vagaDnaId: '55' }] }) });
    assert.equal(inicio.status, 503);
    assert.equal((await fetch(`${app.url}/api/ativacoes`)).status, 200);
  } finally {
    app.child.kill('SIGTERM');
    await once(app.child, 'exit');
  }
});

test('o servidor não tem mais usuário e senha', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(source.includes('APP_PASSWORD'), false);
  assert.equal(source.includes('APP_USER'), false);
  assert.equal(source.includes("startsWith('Basic ')"), false);
});
