'use strict';

// Rotas do agente, separadas do server.js. Só leitura em Pandapé, Postgres e geocodificadores.

const crypto = require('node:crypto');
const { criarIa } = require('./ia');
const { criarGeo } = require('./geo');
const { listarVagasDna } = require('./vagas');
const { sugerirLigacoes } = require('./texto');
const { executarAgente } = require('./job');
const { montarPlanilha } = require('./planilha');

const UMA_HORA = 60 * 60 * 1000;

function erroHttp(status, mensagem) { return Object.assign(new Error(mensagem), { status }); }

function nomeDoArquivo(data) {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(data);
  const v = tipo => p.find(x => x.type === tipo).value;
  return `triagem-${v('year')}-${v('month')}-${v('day')}-${v('hour')}${v('minute')}.xlsx`;
}

/**
 * env: process.env. obterPool(): Pool do pg ou null. erroDoBanco(): texto. snapshots: Map do painel.
 * pandapeGet(caminho): HTML. pandapeBase: URL do Pandapé. maxCandidates: teto da busca.
 */
function criarServicoAgente({ env, obterPool, erroDoBanco, snapshots, pandapeGet, pandapeBase, maxCandidates }) {
  const ia = criarIa({
    url: env.OPENAI_API_URL || 'https://api.openai.com/v1', key: env.OPENAI_API_KEY || '', model: env.LUNA_MODEL || 'gpt-6-luna',
    timeoutMs: Number(env.LUNA_TIMEOUT_MS) > 0 ? Number(env.LUNA_TIMEOUT_MS) : 60000
  });
  const geo = criarGeo({ awesomeUrl: env.GEO_AWESOME_URL || undefined, brasilUrl: env.GEO_BRASILAPI_URL || undefined });
  const vagasDeTeste = env.NODE_ENV === 'test' && env.AGENTE_VAGAS_TESTE_JSON ? JSON.parse(env.AGENTE_VAGAS_TESTE_JSON) : null;
  const jobs = new Map();
  let rodando = false;

  function status() {
    if (!ia.pronta) return { pronto: false, motivo: 'Agente indisponível: configure OPENAI_API_KEY.' };
    if (vagasDeTeste) return { pronto: true, motivo: null };
    if (!env.DATABASE_URL) return { pronto: false, motivo: 'Agente indisponível: configure DATABASE_URL (banco do sistema da DNA).' };
    if (!obterPool()) return { pronto: false, motivo: erroDoBanco() ? `Banco indisponível: ${erroDoBanco()}` : 'Conectando ao banco…' };
    return { pronto: true, motivo: null };
  }

  async function vagasDna() {
    if (vagasDeTeste) return vagasDeTeste;
    const pool = obterPool();
    if (!pool) throw erroHttp(503, status().motivo || 'Banco indisponível.');
    return listarVagasDna(pool);
  }

  function snapshotValido(id) {
    const snapshot = snapshots.get(String(id || ''));
    if (!snapshot || snapshot.expiresAt < Date.now()) throw erroHttp(404, 'A consulta expirou. Busque as vagas de novo.');
    return snapshot;
  }

  async function vagas(snapshotId) {
    const snapshot = snapshotValido(snapshotId);
    const lista = await vagasDna();
    const sugestoes = sugerirLigacoes(snapshot.vacancies, lista);
    return {
      vagasDna: lista.map(v => ({ id: v.id, tipo: v.tipo, rotulo: `${v.cargo} – ${[v.empresa, v.local].filter(Boolean).join(', ') || 'sem loja'} (${v.vagaId || v.id})` })),
      vagasPandape: snapshot.vacancies.map(v => ({ id: v.id, title: v.title, type: v.type, total: v.total, sugestao: sugestoes[v.id] || null }))
    };
  }

  async function iniciar(entrada) {
    const s = status();
    if (!s.pronto) throw erroHttp(503, s.motivo);
    if (rodando) throw erroHttp(409, 'O agente já está analisando. Espere terminar.');
    // Marca antes de qualquer await: dois pedidos simultâneos não podem iniciar duas análises.
    rodando = true;
    try { return await comecar(entrada); }
    catch (error) { rodando = false; throw error; }
  }

  async function comecar(entrada) {
    const snapshot = snapshotValido(entrada?.snapshotId);
    const idsPandape = new Set(snapshot.vacancies.map(v => String(v.id)));
    const ligacoes = (Array.isArray(entrada?.ligacoes) ? entrada.ligacoes : [])
      .filter(l => l && idsPandape.has(String(l.idVacancy)) && l.vagaDnaId)
      .map(l => ({ idVacancy: String(l.idVacancy), vagaDnaId: String(l.vagaDnaId) }));
    if (!ligacoes.length) throw erroHttp(400, 'Ligue pelo menos uma vaga do Pandapé a uma vaga do sistema da DNA.');
    const lista = await vagasDna();
    // Cópia: o snapshot expira em 15 minutos e a análise pode demorar mais.
    const candidatos = snapshot.candidates.filter(c => ligacoes.some(l => l.idVacancy === String(c.idVacancy))).map(c => ({ ...c }));
    const vagasPandape = snapshot.vacancies.map(v => ({ ...v }));
    const avisoGeral = snapshot.candidates.length >= maxCandidates
      ? `A busca parou no teto de ${maxCandidates} pessoas: nem todos os inscritos foram analisados.` : '';

    const job = { id: crypto.randomUUID(), status: 'running', feitos: 0, total: candidatos.length, fase: 'iniciando', criadoEm: Date.now() };
    jobs.set(job.id, job);
    for (const [id, antigo] of jobs) if (Date.now() - antigo.criadoEm > UMA_HORA) jobs.delete(id);
    void (async () => {
      try {
        const resultado = await executarAgente({
          ligacoes, vagasPandape, candidatos, vagasDna: lista, avisoGeral,
          deps: { ia, geo, pandapeBase, perfilHtml: c => pandapeGet(`/Company/Match/Matches/${c.idVacancy}?idvacancyfolder=${c.folderId}&idMatch=${c.idMatch}`) },
          progresso: p => Object.assign(job, p)
        });
        job.planilha = await montarPlanilha(resultado);
        job.arquivo = nomeDoArquivo(resultado.geradoEm);
        job.resumo = resultado.resumo;
        job.status = 'completed';
      } catch (error) {
        console.error('[agente]', error.message);
        job.status = 'failed';
        job.error = 'A análise falhou. Veja os logs do servidor.';
      } finally { rodando = false; }
    })();
    return { jobId: job.id, status: job.status };
  }

  function consultar(id) {
    const job = jobs.get(id);
    if (!job) throw erroHttp(404, 'Análise não encontrada nesta instância.');
    const { planilha, criadoEm, ...publico } = job;
    return publico;
  }

  function planilha(id) {
    const job = jobs.get(id);
    if (!job || job.status !== 'completed') throw erroHttp(404, 'Planilha não encontrada.');
    return { buffer: job.planilha, arquivo: job.arquivo };
  }

  return { status, vagas, iniciar, consultar, planilha };
}

module.exports = { criarServicoAgente };
