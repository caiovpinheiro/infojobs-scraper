'use strict';

// CEP → coordenada. AwesomeAPI primeiro, BrasilAPI depois. Cache em memória por CEP.

function numero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n !== 0 ? n : null;
}
function ponto(lat, lng) {
  const a = numero(lat);
  const b = numero(lng);
  return a !== null && b !== null && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? { lat: a, lng: b } : null;
}

function criarGeo({ fetch = globalThis.fetch, awesomeUrl = 'https://cep.awesomeapi.com.br/json', brasilUrl = 'https://brasilapi.com.br/api/cep/v2', timeoutMs = 10000, esperaMs = 1500 } = {}) {
  const cache = new Map();
  async function ler(url) {
    let resposta = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    // Limite de pedidos (429) ou instabilidade: espera um pouco e tenta mais uma vez.
    if (resposta.status === 429 || resposta.status >= 500) {
      await new Promise(resolve => setTimeout(resolve, esperaMs));
      resposta = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    }
    if (resposta.status === 404 || resposta.status === 400) return { definitivo: true, corpo: null };
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    return { definitivo: true, corpo: await resposta.json() };
  }
  async function pontoDoCep(cep) {
    const digitos = String(cep || '').replace(/\D/g, '');
    if (digitos.length !== 8) return null;
    if (cache.has(digitos)) return cache.get(digitos);
    let falhou = false;
    let achado = null;
    try {
      const { corpo } = await ler(`${awesomeUrl.replace(/\/+$/, '')}/${digitos}`);
      achado = ponto(corpo?.lat, corpo?.lng);
    } catch { falhou = true; }
    if (!achado) {
      try {
        const { corpo } = await ler(`${brasilUrl.replace(/\/+$/, '')}/${digitos}`);
        const c = corpo?.location?.coordinates;
        achado = ponto(c?.latitude, c?.longitude);
      } catch { falhou = true; }
    }
    // Falha de rede não fica em cache: a próxima busca tenta de novo.
    if (achado || !falhou) cache.set(digitos, achado);
    return achado;
  }
  return { pontoDoCep };
}

module.exports = { criarGeo };
