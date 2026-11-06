const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const PANDAPE_EMAIL = process.env.PANDAPE_EMAIL;
const PANDAPE_PASSWORD = process.env.PANDAPE_PASSWORD;
const TITAN_EMAIL = process.env.TITAN_EMAIL || PANDAPE_EMAIL;
const TITAN_PASSWORD = process.env.TITAN_PASSWORD || PANDAPE_PASSWORD;

const SAFETY_MARGIN_MS = 2 * 60 * 60 * 1000; // renova se faltar menos de 2h pro cookie expirar

let cache = { cookie: null, expiresAt: 0 };
let loginInFlight = null;
let ultimoErroScreenshot = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function hostDaEmpresa(url) {
  try { return new URL(url).hostname === "pandape.infojobs.com.br"; }
  catch { return false; }
}
function dominioInfojobs(cookie) {
  return /infojobs\.com\.br$/i.test(cookie.domain || "");
}
function montarAtsWebui(cookies) {
  const porNome = new Map();
  const ordenados = [...cookies].filter(dominioInfojobs).sort((a, b) => {
    const peso = (cookie) => /pandape\.infojobs\.com\.br$/i.test(cookie.domain || "") ? 1 : 0;
    return peso(a) - peso(b);
  });
  for (const cookie of ordenados) porNome.set(cookie.name, cookie);
  const principal = porNome.get("ats-webui");
  if (!principal || !principal.value) return null;
  const marcador = /^chunks-(\d+)$/.exec(String(principal.value).trim());
  if (!marcador) return principal;
  const total = Number(marcador[1]);
  if (!Number.isInteger(total) || total < 1 || total > 20) return null;
  const pedacos = [];
  for (let i = 1; i <= total; i++) {
    const pedaco = porNome.get("ats-webuiC" + i) || porNome.get("ats-webui." + i) || porNome.get("ats-webui-" + i);
    if (!pedaco || !pedaco.value) return null;
    pedacos.push(pedaco);
  }
  const expiracoes = [principal, ...pedacos].map((cookie) => cookie.expires).filter((expires) => expires > 0);
  return {
    ...principal,
    value: pedacos.map((cookie) => cookie.value).join(""),
    expires: expiracoes.length ? Math.min(...expiracoes) : principal.expires,
    chunks: total
  };
}
async function esperarCookie(context, page) {
  const limite = Date.now() + 45000;
  let cookiesVistos = "";
  while (Date.now() < limite) {
    if (/\/connect\/authorize\/callback/i.test(page.url())) {
      const form = page.locator("form").first();
      if (await form.count().catch(() => 0)) {
        await form.evaluate((node) => node.submit()).catch(() => {});
      }
    }
    const cookies = await context.cookies();
    const relacionados = cookies.filter((cookie) => dominioInfojobs(cookie) && /^ats-webui/i.test(cookie.name));
    const assinatura = relacionados.map((cookie) => cookie.name + ":" + String(cookie.value || "").length).sort().join(",");
    if (assinatura && assinatura !== cookiesVistos) {
      cookiesVistos = assinatura;
      log("cookies ats-webui:", assinatura);
    }
    const ats = montarAtsWebui(cookies);
    if (ats && hostDaEmpresa(page.url())) {
      log(
        "sessão aberta em",
        page.url().split("?")[0],
        ats.chunks ? ats.chunks + " partes, " + ats.value.length + " caracteres" : ats.value.length + " caracteres"
      );
      return ats;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(
    "login pareceu ok mas cookie ats-webui não apareceu ou veio incompleto. " +
    (cookiesVistos ? "cookies vistos: " + cookiesVistos + ". " : "") +
    "url final: " + page.url()
  );
}

async function avisoDaPagina(page) {
  const texto = await page.locator("body").innerText().catch(() => "");
  const aviso = texto.split("\n").map((linha) => linha.trim()).find((linha) => linha.length > 8 && linha.length < 180 && /captcha|senha|inv[aá]lid|falhou|erro/i.test(linha));
  return aviso || "";
}
async function entrarNoPandape(page) {
  const email = page.locator("#Username").or(page.getByRole("textbox", { name: /email ou nome de usu[aá]rio/i }));
  const senha = page.locator("#Password").or(page.getByRole("textbox", { name: /^senha$/i }));
  const botao = page.locator("#btLogin");
  await email.first().waitFor({ timeout: 15000 });
  let ultimoAviso = "";
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      await page.waitForFunction(() => typeof window.getRecaptchaToken === "function", { timeout: 20000 });
    } catch {
      if (tentativa === 3) throw new Error("o captcha do Pandapé não carregou. url atual: " + page.url());
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      continue;
    }
    await email.first().fill(PANDAPE_EMAIL);
    await senha.first().fill(PANDAPE_PASSWORD);
    try {
      await page.evaluate(() => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("captcha sem resposta")), 20000);
        window.getRecaptchaToken(() => {
          clearTimeout(timer);
          const token = document.querySelector("#CaptchaInput") && document.querySelector("#CaptchaInput").value;
          if (!token) reject(new Error("captcha sem token"));
          else resolve();
        });
      }));
      // O clique em Entrar envia o formulário antes do token. O envio só acontece com o captcha já preenchido.
      await botao.evaluate((button) => button.form.requestSubmit(button));
    } catch (error) {
      log("falha ao obter captcha:", error.message);
      if (tentativa === 3) throw error;
      await page.waitForTimeout(1500);
      continue;
    }
    const saiu = page.waitForURL(
      (url) => /LoginMultifactor/.test(url.toString()) || /pandape\.infojobs\.com\.br\/Company/.test(url.toString()),
      { timeout: 25000 }
    ).then(() => "ok").catch(() => "parado");
    const recusado = page.getByText(/captcha falhou/i).waitFor({ timeout: 25000 }).then(() => "captcha").catch(() => "parado");
    const resultado = await Promise.race([saiu, recusado]);
    if (resultado === "ok") return;
    ultimoAviso = await avisoDaPagina(page);
    log("login ainda em", page.url().split("?")[0], ultimoAviso || "sem aviso", "tentativa", tentativa);
    if (tentativa === 3) break;
    await page.waitForTimeout(1500);
  }
  throw new Error(
    (ultimoAviso ? "O Pandapé recusou o login (" + ultimoAviso + "). " : "depois de Entrar, travou. ") +
    "url atual: " + page.url()
  );
}
async function fazerLogin() {
  const { chromium } = require("playwright");
  log("iniciando login real no Pandapé...");
  const browser = await chromium.launch({
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
  });
  let page;
  let mailPage;
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "pt-BR"
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    page = await context.newPage();

    await page.goto("https://pandape.infojobs.com.br/Company/Vacancy", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForURL(
        (url) => /login\.pandape\.com/.test(url.toString()) || /pandape\.infojobs\.com\.br\/Company/.test(url.toString()),
        { timeout: 30000 }
      );
    } catch (e) {
      throw new Error("navegação inicial travou, url atual: " + page.url());
    }
    log("após navegação inicial, url=" + page.url());

    if (/login\.pandape\.com/.test(page.url())) {
      await entrarNoPandape(page);
      log("depois de Entrar, url=" + page.url());

      if (/LoginMultifactor/.test(page.url())) {
        log("MFA solicitado, código enviado por e-mail. Abrindo Titan Mail...");

        mailPage = await context.newPage();
        await mailPage.goto("https://app.titan.email/login/", { waitUntil: "domcontentloaded" });
        await mailPage.getByTestId("email-input").fill(TITAN_EMAIL);
        await mailPage.getByTestId("login-btn").click();
        await mailPage.getByTestId("password-input").fill(TITAN_PASSWORD);
        await mailPage.getByTestId("password-input").press("Enter");

        // pode pedir "e-mail de recuperação" na primeira vez — ignora se não aparecer
        try {
          const pular = mailPage.getByText("Farei isso depois");
          await pular.waitFor({ timeout: 8000 });
          await pular.click();
        } catch (e) {
          // não apareceu, segue o jogo
        }

        await mailPage.waitForURL(/app\.titan\.email\/mail/, { timeout: 30000 });

        // Abre a mensagem do Pandapé. O código não aparece na lista da caixa.
        function extrairCodigo(texto) {
          const direto = texto.match(/c[oó]digo de acesso est[aá] aqui:?\s*(\d{6})/i);
          if (direto) return direto[1];
          const perto = texto.match(/c[oó]digo[\s\S]{0,160}?(\d{6})/i);
          return perto ? perto[1] : null;
        }
        async function textoDaTela() {
          const client = await mailPage.context().newCDPSession(mailPage);
          try {
            const snap = await client.send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
            const strings = snap.strings || [];
            const partes = [];
            for (const doc of snap.documents || []) {
              for (const index of doc.layout?.text || []) {
                if (typeof index === "number" && index >= 0 && strings[index]) partes.push(strings[index]);
              }
              for (const rare of [doc.nodes?.textValue, doc.nodes?.nodeValue]) {
                if (!rare || !rare.index) continue;
                for (let i = 0; i < rare.index.length; i++) {
                  const s = strings[rare.value[i]];
                  if (s) partes.push(s);
                }
              }
            }
            return partes.join("\n");
          } catch (e) {
            log("falha ao ler a tela do Titan: " + e.message);
            return "";
          } finally {
            await client.detach().catch(() => {});
          }
        }
        async function abrirMensagem(padrao) {
          for (const frame of mailPage.frames()) {
            const clicou = await frame.evaluate((source) => {
              const re = new RegExp(source, "i");
              const visit = (node) => {
                if (!node || node.nodeType !== 1) return null;
                if (node.shadowRoot) {
                  const interno = visit(node.shadowRoot);
                  if (interno) return interno;
                }
                for (const child of node.children || []) {
                  const interno = visit(child);
                  if (interno) return interno;
                }
                const t = ((node.innerText || "") + " " + (node.getAttribute?.("aria-label") || "") + " " + (node.getAttribute?.("title") || "")).replace(/\s+/g, " ").trim();
                if (t && t.length < 180 && re.test(t)) {
                  node.click();
                  return true;
                }
                return null;
              };
              return Boolean(document.body && visit(document.body));
            }, padrao).catch(() => false);
            if (clicou) return true;
          }
          return false;
        }

        let codigo = null;
        let visto = null;
        const debugInfo = [];
        for (let tentativa = 0; tentativa < 15 && !codigo; tentativa++) {
          await mailPage.waitForTimeout(tentativa === 0 ? 3000 : 4000);
          let texto = await textoDaTela();
          let atual = extrairCodigo(texto);
          let clicou = false;
          if (!atual) {
            clicou = await abrirMensagem("c[oó]digo de acesso");
            if (!clicou) clicou = await abrirMensagem("pandap[eé]");
            if (clicou) {
              await mailPage.waitForTimeout(2000);
              texto = await textoDaTela();
              atual = extrairCodigo(texto);
            }
          }
          if (atual && visto && atual !== visto) codigo = atual;
          else if (atual && tentativa >= 2) codigo = atual;
          if (atual) visto = atual;
          const temPandape = /pandap/i.test(texto);
          debugInfo.push({ tentativa, length: texto.length, temPandape, clicou });
          log(
            "tentativa " + tentativa +
            ": length=" + texto.length +
            " temPandape=" + temPandape +
            " clicou=" + clicou +
            " amostra=" + JSON.stringify(texto.replace(/\d/g, "#").replace(/\s+/g, " ").slice(0, 160))
          );
          if (!codigo && !clicou && tentativa > 0 && tentativa % 4 === 0) {
            await mailPage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          }
        }
        if (!codigo) {
          log("debug completo:", JSON.stringify(debugInfo));
          throw new Error(
            "código de MFA não encontrado no Titan Mail depois de 15 tentativas. últimas: " +
              JSON.stringify(debugInfo.slice(-3))
          );
        }
        log("código encontrado");
        await mailPage.close();
        mailPage = null;

        await page.bringToFront();
        const especifico = page.getByPlaceholder(/c[oó]digo/i)
          .or(page.getByRole("textbox", { name: /c[oó]digo/i }))
          .or(page.getByRole("spinbutton", { name: /c[oó]digo/i }))
          .or(page.locator("input[name='Code' i], #Code"));
        if (await especifico.count()) {
          await especifico.first().fill(codigo);
        } else {
          const caixas = page.locator("input[maxlength='1']");
          if (await caixas.count() >= codigo.length) {
            for (let i = 0; i < codigo.length; i++) await caixas.nth(i).fill(codigo[i]);
          } else {
            const campos = await page.locator("input").evaluateAll((els) => els.map((el) => ({
              type: el.getAttribute("type"),
              name: el.getAttribute("name"),
              id: el.id,
              placeholder: el.getAttribute("placeholder"),
              aria: el.getAttribute("aria-label"),
              max: el.getAttribute("maxlength")
            })));
            log("campo de MFA não identificado. url=" + page.url() + " inputs=" + JSON.stringify(campos));
            await page.locator("input[type='text'], input[type='tel'], input[type='number'], input:not([type])").first().fill(codigo);
          }
        }
        await page.getByRole("button", { name: /continuar|verificar|confirmar/i }).first().click();
      } else {
        log("login não pediu MFA desse vez (dispositivo confiável?), seguiu direto autenticado.");
      }
    } else {
      log("já chegou autenticado direto (sessão prévia?), sem precisar logar de novo.");
    }

    const atsWebui = await esperarCookie(context, page);
    if (!atsWebui.value || /^chunks-\d+$/.test(atsWebui.value)) {
      throw new Error("cookie ats-webui veio só com o marcador de divisão, sem as partes");
    }
    cache = {
      cookie: "ats-webui=" + atsWebui.value,
      expiresAt: atsWebui.expires > 0 ? atsWebui.expires * 1000 : Date.now() + 8 * 60 * 60 * 1000
    };
    log("login concluído, cookie novo válido até", new Date(cache.expiresAt).toISOString());
    return cache;
  } catch (e) {
    const alvo = mailPage || page;
    if (alvo) {
      try {
        const shot = await alvo.screenshot({ type: "jpeg", quality: 40 });
        ultimoErroScreenshot = shot.toString("base64");
      } catch (e2) {
        // sem screenshot mesmo, segue
      }
    }
    throw e;
  } finally {
    await browser.close();
  }
}

async function getCookieValido(forcar) {
  const agora = Date.now();
  if (!forcar && cache.cookie && cache.expiresAt - agora > SAFETY_MARGIN_MS) {
    return { ...cache, fonte: "cache" };
  }
  if (!loginInFlight) {
    loginInFlight = fazerLogin().finally(() => {
      loginInFlight = null;
    });
  }
  const resultado = await loginInFlight;
  return { ...resultado, fonte: "login novo" };
}

module.exports = { montarAtsWebui };

if (require.main === module) {
  const express = require("express");
  const app = express();

  app.get("/health", (req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    if (!AUTH_TOKEN || req.header("x-Auth-Token") !== AUTH_TOKEN) {
      return res.status(401).json({ erro: "token invalido" });
    }
    next();
  });

  app.get("/cookie", async (req, res) => {
    try {
      const forcar = req.query.force === "1" || req.query.force === "true";
      const resultado = await getCookieValido(forcar);
      res.json({
        cookie: resultado.cookie,
        expiresAt: new Date(resultado.expiresAt).toISOString(),
        fonte: resultado.fonte
      });
    } catch (e) {
      log("erro:", e.message);
      res.status(500).json({ erro: e.message });
    }
  });

  app.get("/debug-screenshot", (req, res) => {
    if (!ultimoErroScreenshot) return res.status(404).json({ erro: "sem screenshot ainda" });
    res.set("Content-Type", "image/jpeg");
    res.send(Buffer.from(ultimoErroScreenshot, "base64"));
  });

  app.listen(PORT, () => log("pandape-login service ouvindo na porta " + PORT));
}
