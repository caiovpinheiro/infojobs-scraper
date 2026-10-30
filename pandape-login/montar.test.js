const assert = require("assert");
const { montarAtsWebui } = require("./server");

const completo = montarAtsWebui([
  { name: "ats-webui", value: "chunks-2", domain: "pandape.infojobs.com.br", expires: 200 },
  { name: "ats-webuiC1", value: "AAA", domain: "pandape.infojobs.com.br", expires: 180 },
  { name: "ats-webuiC2", value: "BBB", domain: ".infojobs.com.br", expires: 190 },
  { name: "outro", value: "ignorar", domain: "titan.email", expires: 10 }
]);
assert.strictEqual(completo.value, "AAABBB");
assert.strictEqual(completo.chunks, 2);
assert.strictEqual(completo.expires, 180);

const simples = montarAtsWebui([
  { name: "ats-webui", value: "sessao-inteira", domain: "pandape.infojobs.com.br", expires: 50 }
]);
assert.strictEqual(simples.value, "sessao-inteira");
assert.strictEqual(simples.chunks, undefined);

const incompleto = montarAtsWebui([
  { name: "ats-webui", value: "chunks-2", domain: "pandape.infojobs.com.br", expires: 50 },
  { name: "ats-webuiC1", value: "AAA", domain: "pandape.infojobs.com.br", expires: 50 }
]);
assert.strictEqual(incompleto, null);

const fora = montarAtsWebui([
  { name: "ats-webui", value: "chunks-2", domain: "exemplo.com", expires: 50 },
  { name: "ats-webuiC1", value: "AAA", domain: "exemplo.com", expires: 50 },
  { name: "ats-webuiC2", value: "BBB", domain: "exemplo.com", expires: 50 }
]);
assert.strictEqual(fora, null);

console.log("ok");
