'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const TOKEN = 'login-test-token';
const COOKIE = 'ats-webui=sessao-de-teste';
const calls = [];
let mode = 'ok';
let server;
let base;
let app;

function htmlVacancyList() {
  return '<a href="/Company/Match/Matches/10?idvacancyfolder=1">Estágio em RH</a>';
}
function htmlFolders() {
  return '<input id="hdnVacancyName" value="Estágio em RH"><a href="/Company/Match/Matches/10?idvacancyfolder=77" title="Inscritos">Inscritos</a>';
}
function candidateLink(id, name) {
  return `<a href="?idMatch=${id}" data-username="${name}">`;
}
function pageBody(page) {
  if (page === '1') {
    const links = Array.from({ length: 25 }, (_, i) => candidateLink(100 + i, `Pessoa ${i}`)).join('');
    return JSON.stringify({ total: 30, viewList: links });
  }
  const links = Array.from({ length: 5 }, (_, i) => candidateLink(200 + i, `Pessoa extra ${i}`)).join('');
  return JSON.stringify({ total: 30, viewList: links });
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers['x-auth-token'] || '', cookie: req.headers.cookie || '', body });
      if (req.method === 'POST' && (url.pathname.startsWith('/contacts') || url.pathname.startsWith('/deals'))) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'criação não permitida neste teste' }));
        return;
      }
      if (url.pathname === '/cookie') {
        const force = url.searchParams.get('force');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cookie: force ? 'ats-webui=sessao-renovada' : COOKIE, expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() }));
        return;
      }
      if (url.pathname === '/pipelines') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'pipe', name: 'Candidaturas', stages: [{ id: 'etapa-valida', name: 'Lead de Entrada' }] }]));
        return;
      }
      if (mode === 'redirect' && url.pathname.startsWith('/Company/')) {
        mode = 'ok';
        res.writeHead(302, { Location: '/Account/Login' });
        res.end();
        return;
      }
      if (mode === 'always-redirect' && url.pathname.startsWith('/Company/')) {
        res.writeHead(302, { Location: '/Account/Login' });
        res.end();
        return;
      }
      if (url.pathname === '/Company/Vacancy/ListVacancies') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlVacancyList());
        return;
      }
      if (url.pathname === '/Company/Match/Matches/10') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`${htmlFolders()}<a href="https://wa.me/5511988887777">zap</a><span class="js_CandidateAddressCP"> CEP 01310-100</span>`);
        return;
      }
      if (url.pathname === '/Company/Match/ListMatches') {
        const params = new URLSearchParams(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(pageBody(params.get('PageNumber')));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'nao encontrado' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_USER = 'operador';
  process.env.APP_PASSWORD = 'senha-teste';
  process.env.PANDAPE_LOGIN_URL = base;
  process.env.PANDAPE_LOGIN_TOKEN = TOKEN;
  process.env.PANDAPE_BASE_URL = base;
  process.env.CRM_BASE_URL = base;
  process.env.CRM_API_KEY = 'crm-test';
  process.env.CRM_STAGE_ID = 'etapa-inexistente';
  process.env.CRM_TAG_ID = 'tag-teste';
  process.env.VACANCY_TYPES_JSON = '{}';
  app = require('../server');
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('extrai a aba Inscritos sem classificar pelo título', () => {
  const html = '<a href="/Company/Match/Matches/10?idvacancyfolder=77" title="Inscritos"><input id="hdnVacancyName" value="Estágio em RH">';
  const folders = app.extractFolders(html);
  assert.equal(folders.inscritos, '77');
  assert.equal(folders.title, 'Estágio em RH');
  assert.equal(app.stageIsKnown([{ stages: [{ id: 'etapa-valida' }] }], 'etapa-inexistente'), false);
  assert.equal(app.samePhone('5511988887777', '+55 (11) 98888-7777'), true);
  assert.equal(app.samePhone('5511988887777', '551188887777'), false);
});

test('GET /cookie usa X-Auth-Token, respeita expiresAt e renova uma vez', async () => {
  calls.length = 0;
  app.resetLoginState();
  const first = await app.getPandapeCookie(false);
  const second = await app.getPandapeCookie(false);
  assert.equal(first, COOKIE);
  assert.equal(second, COOKIE);
  assert.equal(calls.filter(call => call.path === '/cookie').length, 1);
  assert.equal(calls[0].auth, TOKEN);
  assert.equal(calls[0].search, '');

  mode = 'redirect';
  const body = await app.listMatches('10', '77', 2, 25, '15/10/2026 12:00:00');
  assert.equal(body.total, 30);
  const cookieCalls = calls.filter(call => call.path === '/cookie');
  assert.equal(cookieCalls.length, 2);
  assert.equal(cookieCalls[1].search, '?force=1');
  const lists = calls.filter(call => call.path === '/Company/Match/ListMatches');
  assert.equal(lists.length, 2);
  assert.match(lists[1].cookie, /^ats-webui=sessao-renovada$/);
  assert.match(lists[1].body, /PageNumber=2/);
  assert.match(lists[1].body, /PageSize=25/);

  calls.length = 0;
  mode = 'always-redirect';
  await assert.rejects(() => app.listMatches('10', '77', 1, 25, '15/10/2026 12:00:00'), /Sessão do Pandapé/);
  assert.equal(calls.filter(call => call.path === '/cookie' && call.search === '?force=1').length, 1);
  assert.equal(calls.filter(call => call.path === '/Company/Match/ListMatches').length, 2);
  mode = 'ok';
});

test('a consulta lista e conta inscritos sem criar no CRM', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      APP_USER: 'operador',
      APP_PASSWORD: 'senha-teste',
      PANDAPE_LOGIN_URL: base,
      PANDAPE_LOGIN_TOKEN: TOKEN,
      PANDAPE_BASE_URL: base,
      CRM_BASE_URL: base,
      CRM_API_KEY: 'crm-test',
      CRM_STAGE_ID: 'etapa-inexistente',
      CRM_TAG_ID: 'tag-teste',
      VACANCY_TYPES_JSON: '{}',
      MAX_VACANCIES: '100',
      MAX_CANDIDATES: '500',
      MAX_IMPORT: '100'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(log || 'servidor não iniciou')), 5000);
    child.stdout.on('data', () => {
      const match = log.match(/porta (\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`saiu ${code}: ${log}`)); });
  });
  try {
    const auth = 'Basic ' + Buffer.from('operador:senha-teste').toString('base64');
    const preview = await fetch(`http://127.0.0.1:${started}/api/preview`, { method: 'POST', headers: { Authorization: auth } });
    assert.equal(preview.status, 202);
    const jobStart = await preview.json();
    let job;
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`http://127.0.0.1:${started}/api/preview/${jobStart.jobId}`, { headers: { Authorization: auth } });
      job = await response.json();
      if (job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result.total, 30);
    assert.equal(job.result.listed, 30);
    assert.equal(job.result.vacancies[0].type, null);
    assert.equal(job.result.vacancies[0].title, 'Estágio em RH');
    assert.equal(job.result.candidates[0].telefone, '5511988887777');
    assert.equal(job.result.candidates[0].cep, '01310-100');
    assert.match(job.result.warnings.join('\n'), /CRM_STAGE_ID/);
    assert.equal(calls.some(call => call.method === 'POST' && (call.path.startsWith('/contacts') || call.path.startsWith('/deals'))), false);
    const pages = calls.filter(call => call.path === '/Company/Match/ListMatches').map(call => new URLSearchParams(call.body).get('PageNumber'));
    assert.deepEqual(pages.filter(page => page === '2').length > 0, true);
    const page = await fetch(`http://127.0.0.1:${started}/`);
    const html = await page.text();
    assert.match(html, /Revisar criação no CRM/);
    assert.equal(html.includes(TOKEN), false);
    assert.equal(html.includes('ats-webui'), false);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});

test('a página e o servidor não carregam segredo nem movem candidato', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(html, /Selecionar primeiras/);
  assert.match(html, /Confirmar criação no CRM/);
  assert.equal(source.includes('MoveToFolder'), false);
  assert.equal(source.includes('discord.com'), false);
  assert.equal(source.includes('graph.facebook.com'), false);
  assert.equal(html.includes('PANDAPE_PASSWORD'), false);
});
