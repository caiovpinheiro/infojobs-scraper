'use strict';

// Aplicativo local: navegador e API usam a mesma origem. Requer Node.js 20+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

function loadDotEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
loadDotEnv();

const config = {
  port: Number(process.env.PORT || 3000),
  user: process.env.APP_USER || '', password: process.env.APP_PASSWORD || '',
  cookie: process.env.PANDAPE_COOKIE || '',
  loginUrl: (process.env.PANDAPE_LOGIN_URL || '').replace(/\/+$/, ''),
  loginToken: process.env.PANDAPE_LOGIN_TOKEN || '',
  deployUrl: process.env.PANDAPE_LOGIN_DEPLOY_URL || '',
  pandapeBase: (process.env.PANDAPE_BASE_URL || 'https://pandape.infojobs.com.br').replace(/\/+$/, ''),
  crmBase: (process.env.CRM_BASE_URL || 'https://integrations.bwipo.com/api').replace(/\/+$/, ''),
  crmKey: process.env.CRM_API_KEY || '',
  stageId: process.env.CRM_STAGE_ID || '', tagId: process.env.CRM_TAG_ID || '',
  maxVacancies: bounded(process.env.MAX_VACANCIES, 100, 1, 500),
  maxCandidates: bounded(process.env.MAX_CANDIDATES, 500, 1, 2000),
  maxImport: bounded(process.env.MAX_IMPORT, 100, 1, 500),
  vacancyTypes: parseTypes(process.env.VACANCY_TYPES_JSON || '{}'),
  databaseUrl: process.env.DATABASE_URL || ''
};
let pool = null;
let databaseError = '';
async function initDatabase() {
  if (!config.databaseUrl) return;
  const next = new Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 8000 });
  next.on('error', error => console.error('[painel] banco:', error.message));
  await next.query(`CREATE TABLE IF NOT EXISTS ativacoes (
    id TEXT PRIMARY KEY,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    nome TEXT NOT NULL,
    telefone TEXT,
    cep TEXT,
    endereco TEXT,
    nascimento DATE,
    idade INTEGER,
    curso TEXT,
    local_ensino TEXT,
    vaga TEXT,
    tipo TEXT,
    id_vaga TEXT,
    id_match TEXT,
    contact_id TEXT,
    deal_id TEXT,
    status TEXT NOT NULL
  )`);
  await next.query('CREATE INDEX IF NOT EXISTS ativacoes_criado_em_idx ON ativacoes (criado_em DESC)');
  pool = next;
}
function startDatabase() {
  initDatabase().catch(error => { databaseError = error.message; console.error('[painel] banco:', error.message); });
}
async function saveAtivacao(c, result) {
  if (!pool || !['criado', 'parcial'].includes(result.status)) return;
  const id = result.dealId || `${c.key}:${result.contactId || 'sem-negocio'}`;
  await pool.query(`INSERT INTO ativacoes (
      id, nome, telefone, cep, endereco, nascimento, idade, curso, local_ensino,
      vaga, tipo, id_vaga, id_match, contact_id, deal_id, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (id) DO NOTHING`, [
    id, c.nome || '', c.telefone || null, c.cep || null, c.endereco || null,
    /^\d{4}-\d{2}-\d{2}$/.test(c.nascimento || '') ? c.nascimento : null,
    Number.isInteger(c.idade) ? c.idade : null, c.curso || null, c.localEnsino || null,
    c.vaga || null, c.tipo || null, c.idVacancy || null, c.idMatch || null,
    result.contactId || null, result.dealId || null, result.status
  ]);
}
async function activatedKeys(candidates) {
  if (!pool || !candidates.length) return new Set();
  const phones = [...new Set(candidates.map(c => canonicalPhone(c.telefone)).filter(Boolean))];
  const vacancies = [...new Set(candidates.map(c => c.idVacancy).filter(Boolean))];
  const matches = [...new Set(candidates.map(c => c.idMatch).filter(Boolean))];
  const result = await pool.query(`SELECT telefone, id_vaga, id_match FROM ativacoes
    WHERE status IN ('criado', 'parcial')
      AND (telefone = ANY($1::text[]) OR (id_vaga = ANY($2::text[]) AND id_match = ANY($3::text[])))`, [phones, vacancies, matches]);
  const phoneSet = new Set(result.rows.map(row => canonicalPhone(row.telefone)).filter(Boolean));
  const matchSet = new Set(result.rows.map(row => `${row.id_vaga}:${row.id_match}`));
  const keys = new Set();
  for (const c of candidates) {
    if ((c.telefone && phoneSet.has(canonicalPhone(c.telefone))) || matchSet.has(`${c.idVacancy}:${c.idMatch}`)) keys.add(c.key);
  }
  return keys;
}
async function listAtivacoes(page) {
  const pageSize = 25;
  const current = Math.max(1, page);
  if (!pool) return { items: [], total: 0, page: current, pages: 1, configured: Boolean(config.databaseUrl), error: databaseError || (config.databaseUrl ? 'Conectando ao banco…' : '') };
  const total = Number((await pool.query('SELECT COUNT(*)::int AS total FROM ativacoes')).rows[0].total);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(current, pages);
  const rows = await pool.query(`SELECT id, criado_em, nome, telefone, cep, endereco, nascimento, idade, curso,
      local_ensino, vaga, tipo, id_vaga, id_match, contact_id, deal_id, status
    FROM ativacoes ORDER BY criado_em DESC LIMIT $1 OFFSET $2`, [pageSize, (safePage - 1) * pageSize]);
  return {
    items: rows.rows.map(row => ({ ...row, criadoEm: row.criado_em, localEnsino: row.local_ensino, idVaga: row.id_vaga, idMatch: row.id_match, contactId: row.contact_id, dealId: row.deal_id })),
    total, page: safePage, pages, configured: true
  };
}
function bounded(value, fallback, min, max) { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; }
function parseTypes(value) {
  let mapping;
  try { mapping = JSON.parse(value); } catch { throw new Error('VACANCY_TYPES_JSON não é um JSON válido.'); }
  if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object') throw new Error('VACANCY_TYPES_JSON deve ser um objeto por ID da vaga.');
  for (const [id, type] of Object.entries(mapping)) {
    if (!/^\d+$/.test(id) || !['CLT', 'ESTAGIO'].includes(type)) throw new Error('VACANCY_TYPES_JSON tem ID ou tipo inválido.');
  }
  return mapping;
}
if (require.main === module && (!config.user || !config.password || !(config.loginUrl && config.loginToken || config.cookie) || !config.crmKey || !config.stageId || Boolean(config.loginUrl) !== Boolean(config.loginToken))) {
  console.error('Configure APP_USER, APP_PASSWORD, CRM_API_KEY, CRM_STAGE_ID e PANDAPE_LOGIN_URL + PANDAPE_LOGIN_TOKEN (ou PANDAPE_COOKIE) no .env.');
  process.exit(1);
}

const snapshots = new Map();
const previewJobs = new Map();
const imports = new Map();
const jobs = new Map();
const attempts = new Map();
let activeImport = false;
let loginCookie = null;
let loginCookieExpiresAt = 0;
let loginQueue = Promise.resolve();
let deployInFlight = null;
const COOKIE_SKEW_MS = 60 * 1000;

function decodeEntities(value) {
  const names = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(value || '').replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (full, entity) => {
    if (entity[0] !== '#') return names[entity.toLowerCase()] ?? full;
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : full;
  }).replace(/<[^>]+>/g, '').trim();
}
function extractVacancies(html) {
  const ids = new Set();
  for (const match of String(html).matchAll(/\/Company\/Match\/Matches\/(\d+)\?idvacancyfolder=\d+/g)) ids.add(match[1]);
  return [...ids];
}
function contractTypeFromLabel(text) {
  const value = decodeEntities(text).replace(/^#/, '').trim();
  if (/^est[aá]gio$/i.test(value) || /\best[aá]gio\b/i.test(value)) return 'ESTAGIO';
  if (/^clt$/i.test(value) || /\bclt\b|efetivo/i.test(value)) return 'CLT';
  return null;
}
function extractContractType(html) {
  const input = String(html);
  const hidden = input.match(/id="hdn_IdContractWorkType"[^>]*value="(\d+)"|value="(\d+)"[^>]*id="hdn_IdContractWorkType"/i);
  const code = hidden?.[1] || hidden?.[2] || '';
  if (code === '4') return 'ESTAGIO';
  if (code === '2') return 'CLT';
  const start = input.indexOf('id="IdContractWorkType"');
  if (start >= 0 && code) {
    const block = input.slice(start, start + 6000);
    const item = [...block.matchAll(/<a class="dropdown-item js_customDDitem" id="(\d+)">\s*<span>([^<]+)<\/span>/g)].find(match => match[1] === code);
    if (item) return contractTypeFromLabel(item[2]);
  }
  return null;
}
function extractVacancyCards(html) {
  const input = String(html);
  const parts = input.split(/<a class="font-xl fw-900 lh-120"/i).slice(1);
  if (!parts.length) return extractVacancies(input).map(id => ({ id, title: '', type: null }));
  const cards = [];
  for (const part of parts) {
    const id = part.match(/Matches\/(\d+)/)?.[1];
    if (!id) continue;
    const title = decodeEntities(part.match(/text-capitalize-first[^>]*>([^<]+)/)?.[1] || '');
    const tags = [...part.matchAll(/js_tagText[^>]*>([^<]+)/g)].map(match => decodeEntities(match[1]));
    let type = null;
    if (tags.some(tag => /^#?\s*est[aá]gio$/i.test(tag.trim()))) type = 'ESTAGIO';
    else if (tags.some(tag => /^#?\s*clt$/i.test(tag.trim()))) type = 'CLT';
    else if (/est[aá]gio/i.test(title)) type = 'ESTAGIO';
    cards.push({ id, title, type });
  }
  return cards;
}
function extractFolders(html) {
  const input = String(html);
  let inscritos;
  for (const tag of input.matchAll(/<a\b[^>]*>/gi)) {
    const el = tag[0];
    if (!/\btitle="Inscritos"/i.test(el)) continue;
    const href = el.match(/\bhref="([^"]+)"/i)?.[1] || '';
    const folder = href.match(/[?&]idvacancyfolder=(\d+)/i)?.[1];
    if (folder) { inscritos = folder; break; }
  }
  return {
    inscritos,
    title: decodeEntities(input.match(/id="hdnVacancyName"\s+value="([^"]*)"/i)?.[1] || '')
  };
}
function extractCandidates(html) {
  const result = [];
  for (const match of String(html).matchAll(/<a href="\?idMatch=(\d+)"[^>]*data-username="([^"]*)"/g)) {
    result.push({ idMatch: match[1], nome: decodeEntities(match[2]) });
  }
  return result;
}
function monthNumber(name) {
  const key = String(name || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 }[key] || 0;
}
function extractDetail(html) {
  const input = String(html);
  const born = input.match(/Nasceu(?:\s+em)?\s+(\d{1,2})\s+(?:de\s+)?([A-Za-zÀ-ÿ]+)\s+de\s+(\d{4})/i);
  const month = born ? monthNumber(born[2]) : 0;
  const day = born ? Number(born[1]) : 0;
  const year = born ? Number(born[3]) : 0;
  let nascimento = null;
  let idade = null;
  if (month && day >= 1 && day <= 31 && year > 1900) {
    nascimento = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const today = new Date();
    idade = today.getFullYear() - year - ((today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) ? 1 : 0);
  }
  const studyMatch = input.match(/((?:Ensino|Curso)[^<]{0,180})<\/strong>/i);
  const studyText = decodeEntities(studyMatch?.[1] || '');
  const level = studyText.match(/^(Ensino\s+[A-Za-zÀ-ÿ]+)/i)?.[1] || '';
  const course = level ? studyText.slice(level.length).trim() : studyText.trim();
  const afterStudy = studyMatch ? input.slice(studyMatch.index + studyMatch[0].length, studyMatch.index + studyMatch[0].length + 400) : '';
  const school = decodeEntities(afterStudy.match(/<span>([^<]{2,160})<\/span>/i)?.[1] || '').replace(/,\s*$/, '').trim();
  return {
    telefone: input.match(/wa\.me\/(\d{10,15})/)?.[1] || null,
    cep: input.match(/class="js_CandidateAddressCP">\s*CEP\s*(\d{5}-?\d{3})/i)?.[1] || null,
    endereco: decodeEntities(input.match(/class="js_CandidateAddress">([^<]+)/i)?.[1] || '').trim() || null,
    nascimento,
    idade: Number.isInteger(idade) && idade >= 0 && idade < 100 ? idade : null,
    curso: course || null,
    localEnsino: school || null
  };
}
function cookieFresh() {
  return Boolean(loginCookie) && loginCookieExpiresAt - Date.now() > COOKIE_SKEW_MS;
}
function enqueueLogin(task) {
  const run = loginQueue.then(task, task);
  loginQueue = run.then(() => {}, () => {});
  return run;
}
function parseExpiry(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Date.parse(value);
}
async function fetchLoginCookie(force) {
  let response;
  try {
    response = await fetch(`${config.loginUrl}/cookie${force ? '?force=1' : ''}`, {
      headers: { 'X-Auth-Token': config.loginToken, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(120000)
    });
  } catch { throw new Error('Não foi possível acessar o serviço pandape-login.'); }
  if (response.status >= 300 && response.status < 400) throw new Error('pandape-login redirecionou a requisição.');
  if (!response.ok) throw new Error(`pandape-login retornou HTTP ${response.status}.`);
  let data;
  try { data = await response.json(); } catch { throw new Error('Resposta inválida do pandape-login.'); }
  const expiry = parseExpiry(data.expiresAt);
  if (typeof data.cookie !== 'string' || !/^ats-webui=[^;\s]+$/.test(data.cookie) || !Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error('Cookie ou validade inválida na resposta do pandape-login.');
  }
  loginCookie = data.cookie;
  loginCookieExpiresAt = expiry;
  return loginCookie;
}
function isStaleCookie(error) {
  return /Cookie ou validade inválida/.test(error.message || '');
}
function deployPollMs() {
  const n = Number(process.env.PANDAPE_LOGIN_DEPLOY_POLL_MS);
  return Number.isFinite(n) && n >= 10 ? n : 3000;
}
function deployTimeoutMs() {
  const n = Number(process.env.PANDAPE_LOGIN_DEPLOY_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 240000;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function triggerDeploy() {
  const send = method => fetch(config.deployUrl, { method, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  let response;
  try { response = await send('POST'); }
  catch { throw new Error('Não foi possível acionar o deploy do pandape-login.'); }
  if (response.status === 404 || response.status === 405) {
    try { response = await send('GET'); }
    catch { throw new Error('Não foi possível acionar o deploy do pandape-login.'); }
  }
  if (response.status >= 400) throw new Error(`Gatilho de deploy do pandape-login retornou HTTP ${response.status}.`);
}
async function healthUp() {
  try {
    const response = await fetch(`${config.loginUrl}/health`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    return response.ok;
  } catch { return false; }
}
async function waitForRestart() {
  const deadline = Date.now() + deployTimeoutMs();
  let sawDown = false;
  while (Date.now() < deadline) {
    const up = await healthUp();
    if (!up) sawDown = true;
    else if (sawDown) return;
    await sleep(deployPollMs());
  }
  throw new Error('O pandape-login não voltou após o deploy.');
}
async function recoverByDeploy() {
  if (!config.deployUrl) throw new Error('Cookie do Pandapé vencido e não há gatilho de deploy configurado.');
  if (!deployInFlight) {
    deployInFlight = (async () => {
      await triggerDeploy();
      await waitForRestart();
      return fetchLoginCookie(true);
    })().finally(() => { deployInFlight = null; });
  }
  return deployInFlight;
}
async function getPandapeCookie(force = false) {
  if (!config.loginUrl) return config.cookie;
  return enqueueLogin(async () => {
    if (!force && cookieFresh()) return loginCookie;
    if (force) { loginCookie = null; loginCookieExpiresAt = 0; }
    try {
      return await fetchLoginCookie(force);
    } catch (error) {
      if (!force && isStaleCookie(error)) {
        try { return await fetchLoginCookie(true); }
        catch (second) {
          if (!config.deployUrl || !isStaleCookie(second)) throw second;
          return recoverByDeploy();
        }
      }
      if (force && config.deployUrl && isStaleCookie(error)) return recoverByDeploy();
      throw error;
    }
  });
}
function resetLoginState() {
  loginCookie = null;
  loginCookieExpiresAt = 0;
  loginQueue = Promise.resolve();
  deployInFlight = null;
}
async function pandapeHeaders(form = false, force = false) {
  return { Cookie: await getPandapeCookie(force), 'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/json',
    ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}) };
}
function pandapeAuthError() {
  const error = new Error('Sessão do Pandapé expirou ou foi recusada.');
  error.code = 'PANDAPE_AUTH';
  return error;
}
async function upstream(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error('Falha de conexão com serviço externo.'); }
  if (response.status >= 300 && response.status < 400) {
    if (url.startsWith(config.pandapeBase)) throw pandapeAuthError();
    throw new Error('Serviço externo redirecionou a requisição; verifique sessão e URL.');
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`Serviço externo retornou HTTP ${response.status}.`);
  if (url.startsWith(config.pandapeBase) && (/<input[^>]*type=["']password/i.test(text) || /\/Account\/Login/i.test(response.url))) {
    throw pandapeAuthError();
  }
  return text;
}
function extractHtml(body) {
  if (typeof body === 'string' && body.trim().startsWith('{')) {
    try { const data = JSON.parse(body); if (typeof data.view === 'string') return data.view; } catch { /* HTML normal */ }
  }
  return body;
}
async function pandapeGet(relativePath) {
  return extractHtml(await pandapeRequest(relativePath));
}
async function pandapeForm(relativePath, params) {
  return pandapeRequest(relativePath, params);
}
async function pandapeRequest(relativePath, params) {
  const form = params !== undefined;
  const makeRequest = async force => {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await upstream(config.pandapeBase + relativePath, {
          ...(form ? { method: 'POST', body: new URLSearchParams(params).toString() } : {}),
          headers: await pandapeHeaders(form, force)
        });
      } catch (error) {
        last = error;
        if (error.code === 'PANDAPE_AUTH' || !/HTTP 403/.test(error.message || '') || attempt === 3) throw error;
        await sleep(2000 * (attempt + 1));
      }
    }
    throw last;
  };
  try { return await makeRequest(false); }
  catch (error) {
    if (error.code !== 'PANDAPE_AUTH' || !config.loginUrl) throw error;
    try { return await makeRequest(true); }
    catch (second) {
      if (second.code !== 'PANDAPE_AUTH' || !config.deployUrl) throw second;
      await recoverByDeploy();
      return makeRequest(false);
    }
  }
}
function brTimestamp() {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const get = key => p.find(x => x.type === key).value;
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
async function listMatches(vacancyId, folderId, page, size, cutoff) {
  const body = await pandapeForm('/Company/Match/ListMatches', {
    PageNumber: page, PageSize: size, Order: 0, IsLast: 'False', IdVacancy: vacancyId,
    IdVacancyFolder: folderId, MaxDatetimeToLoad: cutoff
  });
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('Pandapé não retornou a lista de candidatos em JSON. Verifique o cookie.'); }
  if (!data || typeof data.total !== 'number' || typeof data.viewList !== 'string') throw new Error('Formato da lista de candidatos mudou no Pandapé.');
  return { total: data.total, candidates: extractCandidates(data.viewList) };
}
async function resolvedType(card) {
  if (config.vacancyTypes[card.id]) return config.vacancyTypes[card.id];
  if (card.type) return card.type;
  try { return extractContractType(await pandapeGet(`/Company/Vacancy/Edit/${card.id}`)); }
  catch { return null; }
}
async function findVacancyIds(limit, contractType) {
  const cap = bounded(limit, config.maxVacancies, 1, config.maxVacancies);
  const wanted = contractType === 'CLT' || contractType === 'ESTAGIO' ? contractType : '';
  const byId = new Map();
  let capped = false;
  for (let page = 1; page <= 10 && byId.size < cap; page++) {
    const body = await pandapeForm('/Company/Vacancy/ListVacancies', {
      'Pagination[PageNumber]': page, 'Pagination[PageSize]': 100,
      Order: 1, IdsFilter: 0, BeginDate: '', EndDate: '', Geo: 'false'
    });
    const found = extractVacancyCards(extractHtml(body));
    let added = 0;
    for (const card of found) {
      if (byId.has(card.id)) continue;
      const type = wanted ? await resolvedType(card) : (config.vacancyTypes[card.id] || card.type || null);
      if (wanted && type !== wanted) continue;
      if (byId.size >= cap) { capped = true; break; }
      byId.set(card.id, { ...card, type });
      added++;
    }
    if (capped || found.length < 100) break;
    if (!wanted && added === 0) break;
    if (page === 10) capped = true;
  }
  if (!byId.size) {
    const qual = wanted === 'ESTAGIO' ? 'de estágio' : wanted === 'CLT' ? 'CLT' : '';
    throw new Error(qual ? `Nenhuma vaga ${qual} encontrada nesse limite.` : 'Nenhuma vaga encontrada. Confira o cookie do Pandapé e o acesso aos processos.');
  }
  return { cards: [...byId.values()], capped, limit: cap, contractType: wanted };
}
async function mapLimited(items, limit, callback) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const idx = next++; results[idx] = await callback(items[idx], idx); }
  }));
  return results;
}
async function createPreview(limit, contractType) {
  const vacancyList = await findVacancyIds(limit, contractType);
  const vacancies = [];
  const candidates = [];
  const warnings = [];
  let total = 0;
  const cutoff = brTimestamp();
  for (const card of vacancyList.cards) {
    const id = card.id;
    try {
      const matchPage = await pandapeGet(`/Company/Match/Matches/${id}`);
      const folders = extractFolders(matchPage);
      if (!folders.inscritos) { warnings.push(`Vaga ${id}: aba Inscritos não encontrada.`); continue; }
      let type = config.vacancyTypes[id] || card.type || extractContractType(matchPage);
      if (!type) {
        try { type = extractContractType(await pandapeGet(`/Company/Vacancy/Edit/${id}`)); }
        catch (error) { warnings.push(`Vaga ${id}: tipo de contrato não lido (${error.message}).`); }
      }
      const first = await listMatches(id, folders.inscritos, 1, 25, cutoff);
      const vacancy = { id, title: folders.title || card.title || `Vaga ${id}`, type, total: first.total };
      vacancies.push(vacancy); total += first.total;
      if (candidates.length >= config.maxCandidates || first.total === 0) continue;
      const seen = new Set();
      for (let page = 1; page <= 80 && seen.size < first.total && candidates.length < config.maxCandidates; page++) {
        const batch = page === 1 ? first : await listMatches(id, folders.inscritos, page, 25, cutoff);
        if (!batch.candidates.length) break;
        for (const c of batch.candidates) {
          if (seen.has(c.idMatch)) continue;
          seen.add(c.idMatch);
          candidates.push({ key: `${id}:${c.idMatch}`, idMatch: c.idMatch, idVacancy: id, nome: c.nome,
            vaga: vacancy.title, tipo: vacancy.type, telefone: null, cep: null, folderId: folders.inscritos });
          if (candidates.length >= config.maxCandidates) break;
        }
      }
    } catch (error) { warnings.push(`Vaga ${id}: ${error.message}`); }
  }
  await mapLimited(candidates, 5, async c => {
    try {
      Object.assign(c, extractDetail(await pandapeGet(`/Company/Match/Matches/${c.idVacancy}?idvacancyfolder=${c.folderId}&idMatch=${c.idMatch}`)));
    } catch (error) { c.detailError = error.message; }
  });
  const already = await activatedKeys(candidates);
  for (const candidate of candidates) candidate.ativado = already.has(candidate.key);
  const stageWarning = await missingStageWarning();
  if (stageWarning) warnings.push(stageWarning);
  const id = crypto.randomUUID();
  const snapshot = { id, candidates, vacancies, expiresAt: Date.now() + 15 * 60_000 };
  snapshots.set(id, snapshot);
  for (const [key, value] of snapshots) if (value.expiresAt < Date.now()) snapshots.delete(key);
  return { snapshotId: id, expiresAt: new Date(snapshot.expiresAt).toISOString(), total, listed: candidates.length, maxImport: config.maxImport,
    vacancyLimit: vacancyList.limit, contractType: vacancyList.contractType, truncated: vacancyList.capped || total > candidates.length, vacancies, candidates, warnings };
}
function startPreview(limit, contractType) {
  const running = [...previewJobs.values()].find(job => job.status === 'running');
  if (running) return { jobId: running.id, status: running.status };
  const job = { id: crypto.randomUUID(), status: 'running' };
  previewJobs.set(job.id, job);
  if (previewJobs.size > 20) previewJobs.delete(previewJobs.keys().next().value);
  void (async () => {
    try { job.result = await createPreview(limit, contractType); job.status = 'completed'; }
    catch (error) { job.error = error.message; job.status = 'failed'; }
  })();
  return { jobId: job.id, status: job.status };
}
function canonicalPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}
function samePhone(left, right) {
  const a = canonicalPhone(left);
  const b = canonicalPhone(right);
  return Boolean(a) && a === b;
}
let crmQueue = Promise.resolve();
let crmNextAt = 0;
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function crm(method, relativePath, payload) {
  const run = crmQueue.then(() => crmRequest(method, relativePath, payload));
  crmQueue = run.then(() => {}, () => {});
  return run;
}
async function crmRequest(method, relativePath, payload) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = crmNextAt - Date.now();
    if (wait > 0) await sleep(wait);
    crmNextAt = Date.now() + 250;
    let response;
    try {
      response = await fetch(config.crmBase + relativePath, {
        method,
        headers: { Authorization: `Bearer ${config.crmKey}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(30000)
      });
    } catch { throw new Error('Falha de conexão com serviço externo.'); }
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'));
      await sleep((Number.isFinite(retry) && retry > 0 ? retry : 2) * 1000);
      continue;
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`Serviço externo retornou HTTP ${response.status}.`);
    try { return JSON.parse(text); } catch { return null; }
  }
  throw new Error('O CRM limitou as requisições. Aguarde e tente o restante de novo.');
}
function items(body) { return Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : []; }
function stageIsKnown(pipelines, stageId) {
  if (!Array.isArray(pipelines) || !pipelines.length || !stageId) return null;
  const ids = pipelines.flatMap(pipeline => (pipeline.stages || []).map(stage => stage.id));
  if (!ids.length) return null;
  return ids.includes(stageId);
}
async function missingStageWarning() {
  try {
    const known = stageIsKnown(await crm('GET', '/pipelines'), config.stageId);
    if (known === false) return 'CRM_STAGE_ID não está entre as etapas atuais do Bwipo. A consulta não gravou nada; a criação só deve ser confirmada depois de corrigir a etapa.';
  } catch { /* a consulta do Pandapé não depende dessa leitura */ }
  return null;
}
const DEAL_FIELDS = {
  nome: 'cmp4dyx8q001roz01iptji82l',
  cep: 'cmp4e0z42001zoz01a4wnefez',
  endereco: 'cmp4e17hv0021oz01zqc35opj',
  telefone: 'cmph75ym5001bpd012nrva1ep',
  nascimento: 'cmp4dpyds000roz01b6a1vcwx',
  idade: 'cmph7781k0021pd01837nu1zv',
  tipo: 'cmpmup2wy009xqg01yqayxgcd',
  titulo: 'cmsnfvxzi1s5buh01uugfrkh2',
  curso: 'cmud4gdsf0yd6s601fxtobzh8',
  localEnsino: 'cmph78u8n0029pd01f2k80ih0'
};
let crmTargets = null;
function fold(value) { return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); }
async function ensureTag(tags, name) {
  const found = tags.find(tag => fold(tag.name) === fold(name));
  if (found?.id) return found.id;
  const created = await crm('POST', '/tags', { name, color: '#2563eb' });
  if (!created?.id) throw new Error('Não foi possível criar a tag ' + name);
  tags.push(created);
  return created.id;
}
function resetCrmTargets() { crmTargets = null; }
async function loadCrmTargets() {
  if (crmTargets) return crmTargets;
  const pipelines = await crm('GET', '/pipelines');
  const list = Array.isArray(pipelines) ? pipelines : [];
  const pipeline = list.find(item => fold(item.name).includes('candidatura'));
  const stage = pipeline?.stages?.find(item => fold(item.name) === 'ativacoes');
  if (!stage?.id) throw new Error('Etapa Ativações não encontrada no pipeline Candidaturas.');
  const tags = items(await crm('GET', '/tags'));
  crmTargets = {
    stageId: stage.id,
    tags: {
      CLT: await ensureTag(tags, 'INFOJOBS - CLT'),
      ESTAGIO: await ensureTag(tags, 'INFOJOBS - ESTÁGIO')
    }
  };
  return crmTargets;
}
function candidateNote(c, phone) {
  const lines = [
    ['Nome', c.nome],
    ['Telefone', phone],
    ['CEP', c.cep],
    ['Endereço', c.endereco],
    ['Nascimento', c.nascimento],
    ['Idade', c.idade],
    ['Curso', c.curso],
    ['Local de ensino', c.localEnsino],
    ['Vaga', c.vaga],
    ['Tipo de contrato', c.tipo === 'ESTAGIO' ? 'Estágio' : 'CLT'],
    ['Processo Pandapé', c.idVacancy],
    ['Match', c.idMatch]
  ];
  return ['Candidato InfoJobs', '', ...lines.filter(([, value]) => value !== null && value !== undefined && value !== '').map(([label, value]) => `${label}: ${value}`)].join('\n');
}
function dealCustomFields(c, phone) {
  const tipo = c.tipo === 'ESTAGIO' ? 'Estágio' : 'CLT';
  const values = {
    nome: c.nome,
    cep: c.cep,
    endereco: c.endereco,
    telefone: phone ? String(phone).replace(/^55(?=\d{10,11}$)/, "") : null,
    nascimento: c.nascimento,
    idade: c.idade == null ? null : String(c.idade),
    tipo,
    titulo: c.vaga,
    curso: c.curso,
    localEnsino: c.localEnsino
  };
  return Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({ fieldId: DEAL_FIELDS[key], value }));
}
async function saveDealFields(dealId, c, phone) {
  const values = dealCustomFields(c, phone);
  if (!values.length) return;
  await crm('PUT', `/deals/${encodeURIComponent(dealId)}/custom-fields`, { values });
}
function noteWaitMs() {
  const n = Number(process.env.CRM_NOTE_WAIT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 45000;
}
function notePollMs() {
  const n = Number(process.env.CRM_NOTE_POLL_MS);
  return Number.isFinite(n) && n >= 10 ? n : 2000;
}
async function postInternalNote(contactId, content) {
  const deadline = Date.now() + noteWaitMs();
  let conversation = null;
  while (!conversation?.id) {
    conversation = items(await crm('GET', '/conversations?contactId=' + encodeURIComponent(contactId)))[0];
    if (conversation?.id || Date.now() >= deadline) break;
    await sleep(notePollMs());
  }
  if (!conversation?.id) throw new Error('Conversa do contato não encontrada para a nota interna.');
  const sent = await crm('POST', `/conversations/${encodeURIComponent(conversation.id)}/messages`, { content, private: true, isPrivate: true });
  const message = sent?.message && typeof sent.message === 'object' ? sent.message : sent;
  if (message?.isPrivate === false || message?.private === false) throw new Error('A nota interna saiu como mensagem.');
}
async function createInCrm(c) {
  if (!c.telefone) return { key: c.key, status: 'sem_telefone', nome: c.nome };
  const phone = canonicalPhone(c.telefone);
  const result = { key: c.key, status: 'erro', nome: c.nome, contactId: null, dealId: null };
  try {
    const targets = await loadCrmTargets();
    const found = items(await crm('GET', '/contacts?phone=' + encodeURIComponent(`+${phone}`)));
    let contact = found.find(x => samePhone(x.phone, phone));
    if (!contact) contact = await crm('POST', '/contacts', { name: c.nome, phone });
    if (!contact?.id) throw new Error('CRM não retornou o ID do contato.');
    result.contactId = contact.id;
    const deals = items(await crm('GET', '/deals?contactId=' + encodeURIComponent(contact.id)));
    if (deals.length) { result.status = 'ja_existe'; result.dealId = deals[0].id; return result; }
    const deal = await crm('POST', '/deals', {
      stageId: targets.stageId,
      contactId: contact.id,
      title: c.nome
    });
    if (!deal?.id) throw new Error('CRM não retornou o ID do negócio.');
    result.dealId = deal.id;
    try {
      await saveDealFields(deal.id, c, phone);
      const tagId = targets.tags[c.tipo];
      if (!tagId) throw new Error('Tag do tipo de contrato não encontrada.');
      await crm('POST', `/deals/${encodeURIComponent(deal.id)}/tags`, { tagId });
    } catch (error) {
      result.status = 'parcial';
      result.error = `Negócio criado, mas campos ou tag falharam: ${error.message}`;
      return result;
    }
    try {
      await postInternalNote(contact.id, candidateNote(c, phone));
      result.status = 'criado';
    } catch (error) { result.status = 'parcial'; result.error = `Negócio criado, mas a nota interna falhou: ${error.message}`; }
  } catch (error) { result.error = error.message; }
  return result;
}
async function verifyMembership(selected) {
  const groups = new Map();
  for (const c of selected) { if (!groups.has(c.idVacancy)) groups.set(c.idVacancy, []); groups.get(c.idVacancy).push(c); }
  const found = new Set();
  const cutoff = brTimestamp();
  for (const [id, group] of groups) {
    const folder = extractFolders(await pandapeGet(`/Company/Match/Matches/${id}`)).inscritos;
    if (!folder) continue;
    const requested = new Set(group.map(c => c.idMatch));
    for (let page = 1; page <= 80 && requested.size; page++) {
      const response = await listMatches(id, folder, page, 25, cutoff);
      for (const c of response.candidates) if (requested.delete(c.idMatch)) found.add(`${id}:${c.idMatch}`);
      if (!response.candidates.length || page * 25 >= response.total) break;
    }
  }
  return found;
}
async function importCandidates(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.keys) || !['CLT', 'ESTAGIO'].includes(input.tipo) || !/^[0-9a-f-]{36}$/i.test(input.requestId || '')) {
    throw Object.assign(new Error('Seleção inválida.'), { status: 400 });
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ snapshotId: input.snapshotId, keys: input.keys, tipo: input.tipo, classifications: input.classifications || {} })).digest('hex');
  if (imports.has(input.requestId)) {
    const previous = imports.get(input.requestId);
    if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('Esse identificador já foi usado para outra seleção.'), { status: 409 });
    return { jobId: previous.job.id, status: previous.job.status };
  }
  if (activeImport) throw Object.assign(new Error('Já existe uma importação em andamento.'), { status: 409 });
  const snapshot = snapshots.get(input.snapshotId);
  if (!snapshot || snapshot.expiresAt < Date.now()) throw Object.assign(new Error('Consulta expirou. Atualize a lista.'), { status: 409 });
  const keys = [...new Set(input.keys)];
  if (!keys.length || keys.length !== input.keys.length || keys.length > config.maxCandidates) {
    throw Object.assign(new Error(`Selecione entre 1 e ${config.maxCandidates} pessoas sem repetições.`), { status: 400 });
  }
  const classifications = input.classifications || {};
  if (typeof classifications !== 'object' || Array.isArray(classifications)) throw Object.assign(new Error('Classificação inválida.'), { status: 400 });
  const byKey = new Map(snapshot.candidates.map(c => [c.key, c]));
  const selected = keys.map(key => byKey.get(key));
  if (selected.some(c => !c)) throw Object.assign(new Error('Candidato fora da consulta.'), { status: 400 });
  const resolvedType = c => config.vacancyTypes[c.idVacancy] || c.tipo || snapshot.vacancies.find(v => v.id === c.idVacancy)?.type || classifications[c.idVacancy];
  if (selected.some(c => resolvedType(c) !== input.tipo)) {
    throw Object.assign(new Error('Classifique todas as vagas selecionadas com o tipo escolhido.'), { status: 400 });
  }
  const serverCandidates = selected.map(c => ({ ...c, tipo: input.tipo }));
  const job = { id: crypto.randomUUID(), status: 'running', total: selected.length, processed: 0, created: 0,
    existing: 0, partial: 0, skipped: 0, errors: 0, results: [] };
  imports.set(input.requestId, { job, fingerprint });
  jobs.set(job.id, job);
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value);
  activeImport = true;
  void (async () => { try {
    const membership = await verifyMembership(serverCandidates);
    const already = await activatedKeys(serverCandidates);
    const seenPhones = new Set();
    for (const c of serverCandidates) {
      let result;
      if (already.has(c.key) || c.ativado) result = { key: c.key, nome: c.nome, status: 'ja_ativado' };
      else if (!membership.has(c.key)) result = { key: c.key, nome: c.nome, status: 'nao_inscrito' };
      else {
        try {
          if (!c.telefone) Object.assign(c, extractDetail(await pandapeGet(`/Company/Match/Matches/${c.idVacancy}?idvacancyfolder=${c.folderId}&idMatch=${c.idMatch}`)));
          if (c.telefone && seenPhones.has(canonicalPhone(c.telefone))) result = { key: c.key, nome: c.nome, status: 'telefone_repetido' };
          else {
            if (c.telefone) seenPhones.add(canonicalPhone(c.telefone));
            result = await createInCrm(c);
          }
        } catch (error) { result = { key: c.key, nome: c.nome, status: 'erro', error: `Detalhes do Pandapé: ${error.message}` }; }
      }
      job.results.push(result); job.processed++;
      saveAtivacao(c, result).catch(error => console.error('[painel] ativacao:', error.message));
      if (result.status === 'criado') job.created++;
      if (result.status === 'ja_existe') job.existing++;
      if (result.status === 'parcial') job.partial++;
      if (['sem_telefone', 'nao_inscrito', 'telefone_repetido', 'ja_ativado'].includes(result.status)) job.skipped++;
      if (result.status === 'erro') job.errors++;
    }
    job.status = 'completed';
  } catch (error) { job.status = 'failed'; job.error = error.message; }
  finally { activeImport = false; } })();
  return { jobId: job.id, status: job.status };
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
}
function equalSecret(a, b) { return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest()); }
function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const text = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const delimiter = text.indexOf(':');
  if (delimiter < 0) return false;
  return equalSecret(text.slice(0, delimiter), config.user) && equalSecret(text.slice(delimiter + 1), config.password);
}
function readJson(req, allowEmpty = false) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 128_000) { reject(Object.assign(new Error('Pedido grande demais.'), { status: 413 })); req.destroy(); } });
    req.on('end', () => {
      if (!body) { if (allowEmpty) resolve({}); else reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); return; }
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function sourcePage(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
}
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sourcePage(res);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Página não encontrada.' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  if (!authorized(req)) {
    const old = attempts.get(ip) || { n: 0, since: Date.now() };
    const attempt = Date.now() - old.since > 60_000 ? { n: 1, since: Date.now() } : { n: old.n + 1, since: old.since };
    attempts.set(ip, attempt);
    return send(res, attempt.n > 10 ? 429 : 401, { error: 'Acesso não autorizado.' });
  }
  attempts.delete(ip);
  if (req.method === 'POST' && url.pathname === '/api/preview') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Origem não permitida.' });
    const input = await readJson(req, true);
    const maxVacancies = input && typeof input === 'object' ? input.maxVacancies : undefined;
    const contractType = input && typeof input === 'object' ? input.contractType || '' : '';
    if (contractType && contractType !== 'CLT' && contractType !== 'ESTAGIO') return send(res, 400, { error: 'Tipo de contrato inválido. Use CLT ou estágio.' });
    return send(res, 202, startPreview(maxVacancies, contractType));
  }
  if (req.method === 'GET' && url.pathname === '/api/ativacoes') {
    const page = Number(url.searchParams.get('page'));
    return send(res, 200, await listAtivacoes(Number.isInteger(page) ? page : 1));
  }
  if (req.method === 'GET' && /^\/api\/preview\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    const job = previewJobs.get(url.pathname.split('/').pop());
    return job ? send(res, 200, job) : send(res, 404, { error: 'Consulta não encontrada nesta instância.' });
  }
  if (req.method === 'GET' && /^\/api\/import\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    const job = jobs.get(url.pathname.split('/').pop());
    return job ? send(res, 200, job) : send(res, 404, { error: 'Lote não encontrado nesta instância.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/import') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Origem não permitida.' });
    return send(res, 202, await importCandidates(await readJson(req)));
  }
  return send(res, 404, { error: 'Operação não encontrada.' });
}
if (require.main === module) {
  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      console.error('[painel]', error.message);
      if (!res.headersSent) send(res, error.status || 502, { error: error.status ? error.message : 'Falha ao consultar Pandapé ou CRM. Verifique os logs do servidor.' });
    });
  });
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Painel iniciado na porta ${server.address().port}`);
    startDatabase();
  });
}

module.exports = {
  extractVacancies, extractVacancyCards, extractFolders, extractContractType, extractCandidates, extractDetail, decodeEntities,
  getPandapeCookie, resetLoginState, listMatches, canonicalPhone, samePhone, stageIsKnown,
  createInCrm, resetCrmTargets, DEAL_FIELDS
};
