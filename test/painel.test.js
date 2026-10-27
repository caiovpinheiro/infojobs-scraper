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
let cookieBehavior = 'valid';
let deployed = false;
let healthDown = 0;
let crmMode = false;
let existingDeal = '';
let conversationMisses = 0;
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
      if (crmMode) {
        const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (url.pathname === '/pipelines') return json([{ id: 'pipe', name: 'Candidaturas', stages: [{ id: 'etapa-ativacoes', name: 'Ativações' }] }]);
        if (url.pathname === '/tags' && req.method === 'GET') return json({ items: [] });
        if (url.pathname === '/tags' && req.method === 'POST') return json({ id: 'tag-' + JSON.parse(body).name, name: JSON.parse(body).name });
        if (url.pathname === '/contacts' && req.method === 'GET') return json({ items: [] });
        if (url.pathname === '/contacts' && req.method === 'POST') return json({ id: 'contact-1', name: 'Pessoa Teste', phone: JSON.parse(body).phone });
        if (url.pathname === '/deals' && req.method === 'GET') {
          if (existingDeal === 'ativacoes') return json({ items: [{ id: 'deal-antiga', stageId: 'etapa-ativacoes', title: 'Pessoa Teste' }] });
          if (existingDeal === 'outra') return json({ items: [{ id: 'deal-b2b', stageId: 'etapa-b2b', title: 'Outro negócio' }] });
          return json({ items: [] });
        }
        if (url.pathname === '/deals' && req.method === 'POST') return json({ id: 'deal-1' });
        if (url.pathname === '/deals/deal-1/custom-fields' && req.method === 'PUT') return json({ ok: true });
        if (url.pathname === '/deals/deal-1/tags' && req.method === 'POST') return json({ ok: true });
        if (url.pathname === '/conversations' && req.method === 'GET') {
          if (conversationMisses > 0) { conversationMisses -= 1; return json({ items: [] }); }
          return json({ items: [{ id: 'conv-1' }] });
        }
        if (url.pathname === '/conversations/conv-1/messages' && req.method === 'POST') {
          const payload = JSON.parse(body);
          return json({ id: 'msg-1', isPrivate: payload.isPrivate === true || payload.private === true, content: payload.content });
        }
      }
      if (req.method === 'POST' && (url.pathname.startsWith('/contacts') || url.pathname.startsWith('/deals'))) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'criação não permitida neste teste' }));
        return;
      }
      if (url.pathname === '/cookie') {
        const force = url.searchParams.get('force');
        const expired = cookieBehavior === 'expired-unless-force' ? !force : cookieBehavior === 'expired-until-deploy' ? !deployed : false;
        const cookie = deployed ? 'ats-webui=sessao-pos-deploy' : force ? 'ats-webui=sessao-renovada' : COOKIE;
        const expiresAt = new Date(Date.now() + (expired ? -60_000 : 2 * 60 * 60 * 1000)).toISOString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cookie, expiresAt }));
        return;
      }
      if (url.pathname === '/health') {
        if (healthDown > 0) { healthDown -= 1; res.writeHead(503); res.end('down'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/deploy' && req.method === 'POST') {
        deployed = true;
        healthDown = 2;
        res.writeHead(202, { 'Content-Type': 'text/plain' });
        res.end('queued');
        return;
      }
      if (url.pathname === '/pipelines') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'pipe', name: 'Candidaturas', stages: [{ id: 'etapa-valida', name: 'Lead de Entrada' }] }]));
        return;
      }
      if (mode === 'not-found-once' && url.pathname.startsWith('/Company/')) {
        mode = 'ok';
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('nao encontrado');
        return;
      }
      if (mode === 'always-404' && url.pathname.startsWith('/Company/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('nao encontrado');
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
  process.env.PANDAPE_LOGIN_DEPLOY_URL = `${base}/deploy`;
  process.env.PANDAPE_LOGIN_DEPLOY_POLL_MS = '15';
  process.env.PANDAPE_LOGIN_DEPLOY_TIMEOUT_MS = '5000';
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
  assert.equal(calls.filter(call => call.path === '/deploy').length, 1);
  mode = 'ok';
});

test('HTTP 404 renova o cookie uma vez e não implanta o login', async () => {
  calls.length = 0;
  app.resetLoginState();
  mode = 'not-found-once';
  const body = await app.listMatches('10', '77', 1, 25, '22/10/2026 12:00:00');
  assert.equal(body.total, 30);
  assert.equal(calls.filter(call => call.path === '/cookie' && call.search === '?force=1').length, 1);
  assert.equal(calls.filter(call => call.path === '/deploy').length, 0);

  calls.length = 0;
  app.resetLoginState();
  mode = 'always-404';
  await assert.rejects(() => app.listMatches('10', '77', 1, 25, '22/10/2026 12:00:00'), /negou o acesso/);
  assert.equal(calls.filter(call => call.path === '/cookie' && call.search === '?force=1').length, 1);
  assert.equal(calls.filter(call => call.path === '/deploy').length, 0);
  mode = 'ok';
});

test('cookie vencido renova com force e só implanta se a sessão continuar vencida', async () => {
  calls.length = 0;
  app.resetLoginState();
  deployed = false;
  healthDown = 0;
  cookieBehavior = 'expired-unless-force';
  const renewed = await app.getPandapeCookie(false);
  assert.equal(renewed, 'ats-webui=sessao-renovada');
  assert.equal(calls.filter(call => call.path === '/deploy').length, 0);
  assert.equal(calls.filter(call => call.path === '/cookie' && call.search === '?force=1').length, 1);

  calls.length = 0;
  app.resetLoginState();
  deployed = false;
  healthDown = 0;
  cookieBehavior = 'expired-until-deploy';
  const afterDeploy = await app.getPandapeCookie(false);
  assert.equal(afterDeploy, 'ats-webui=sessao-pos-deploy');
  assert.equal(calls.filter(call => call.path === '/deploy').length, 1);
  cookieBehavior = 'valid';
  deployed = false;
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

test('criação grava os campos, a tag e a nota interna da conversa', async () => {
  calls.length = 0;
  crmMode = true;
  existingDeal = '';
  conversationMisses = 3;
  process.env.CRM_NOTE_POLL_MS = '15';
  process.env.CRM_NOTE_WAIT_MS = '5000';
  app.resetCrmTargets();
  const result = await app.createInCrm({
    key: '10:100', nome: 'Pessoa Teste', telefone: '11988887777', cep: '01310-100',
    endereco: 'Rua A, 10', nascimento: '2000-01-02', idade: 25, curso: 'Administração',
    localEnsino: 'Escola X', vaga: 'Estágio em RH', tipo: 'ESTAGIO', idVacancy: '10', idMatch: '100'
  });
  assert.equal(result.status, 'criado', result.error);
  const fields = JSON.parse(calls.find(call => call.method === 'PUT' && call.path.endsWith('/custom-fields')).body);
  const byId = Object.fromEntries(fields.values.map(item => [item.fieldId, item.value]));
  assert.equal(byId[app.DEAL_FIELDS.nome], 'Pessoa Teste');
  assert.equal(byId[app.DEAL_FIELDS.telefone], '11988887777');
  assert.equal(byId[app.DEAL_FIELDS.cep], '01310-100');
  assert.equal(byId[app.DEAL_FIELDS.endereco], 'Rua A, 10');
  assert.equal(byId[app.DEAL_FIELDS.nascimento], '2000-01-02');
  assert.equal(byId[app.DEAL_FIELDS.idade], '25');
  assert.equal(byId[app.DEAL_FIELDS.tipo], 'Estágio');
  assert.equal(byId[app.DEAL_FIELDS.titulo], 'Estágio em RH');
  assert.equal(byId[app.DEAL_FIELDS.curso], 'Administração');
  assert.equal(byId[app.DEAL_FIELDS.localEnsino], 'Escola X');
  const tag = calls.find(call => call.method === 'POST' && call.path === '/deals/deal-1/tags');
  assert.equal(JSON.parse(tag.body).tagId, 'tag-INFOJOBS - ESTÁGIO');
  const noteCall = calls.find(call => call.method === 'POST' && call.path === '/conversations/conv-1/messages');
  const note = JSON.parse(noteCall.body);
  assert.equal(note.private, true);
  assert.equal(note.isPrivate, true);
  assert.match(note.content, /Candidato InfoJobs/);
  assert.match(note.content, /Estágio em RH/);
  assert.match(note.content, /01310-100/);
  assert.ok(calls.indexOf(tag) < calls.indexOf(noteCall));
  assert.equal(calls.filter(call => call.path === '/conversations').length, 4);
  crmMode = false;
  existingDeal = '';
});

test('negócio fora de Ativações não impede criar; negócio nessa etapa é pulado', async () => {
  calls.length = 0;
  crmMode = true;
  existingDeal = 'outra';
  conversationMisses = 0;
  process.env.CRM_NOTE_POLL_MS = '15';
  process.env.CRM_NOTE_WAIT_MS = '2000';
  app.resetCrmTargets();
  const person = {
    key: '10:100', nome: 'Pessoa Teste', telefone: '11988887777', cep: '01310-100',
    vaga: 'Operador de Caixa', tipo: 'CLT', idVacancy: '10', idMatch: '100'
  };
  const created = await app.createInCrm(person);
  assert.equal(created.status, 'criado', created.error);
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/deals').length, 1);

  calls.length = 0;
  app.resetCrmTargets();
  existingDeal = 'ativacoes';
  const skipped = await app.createInCrm(person);
  assert.equal(skipped.status, 'ja_existe');
  assert.equal(skipped.dealId, 'deal-antiga');
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/deals').length, 0);
  crmMode = false;
  existingDeal = '';
});

test('vaga sem inscritos não é erro de formato', () => {
  const empty = app.parseMatchList(JSON.stringify({
    url: '/company/match/matches', viewTitle: '\n', viewChips: '', isLast: true,
    viewNoResults: '<div class="card-noresults">Não há resultados</div>'
  }));
  assert.deepEqual(empty, { total: 0, candidates: [] });
  const listed = app.parseMatchList(JSON.stringify({
    total: 1, viewList: '<a href="?idMatch=9" data-username="Ana"></a>', isLast: true
  }));
  assert.equal(listed.total, 1);
  assert.equal(listed.candidates[0].idMatch, '9');
  assert.throws(() => app.parseMatchList('{"ok":true}'), /Formato da lista/);
});

test('a página e o servidor não carregam segredo nem movem candidato', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(html, /Selecionar primeiras/);
  assert.match(html, /A busca não traz pessoa que já foi disparada/);
  assert.match(html, /Confirmar criação no CRM/);
  assert.match(source, /'MISTO'/);
  assert.equal(source.includes('MoveToFolder'), false);
  assert.equal(source.includes('discord.com'), false);
  assert.equal(source.includes('graph.facebook.com'), false);
  assert.equal(html.includes('PANDAPE_PASSWORD'), false);
});
