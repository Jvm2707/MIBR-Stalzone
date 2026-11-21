// Teste rápido das regras de segurança, sem instalar nada: node worker/test.mjs
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import worker from './worker.js';

crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b)); // só existe no Workers

const store = new Map();
const KV = {
  async get(k, type) { const v = store.get(k)?.v; return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
  async getWithMetadata(k) { const e = store.get(k); return { value: e?.v ?? null, metadata: e?.meta }; },
  async put(k, v, o) { store.set(k, { v, meta: o?.metadata }); },
  async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
};
const env = { KV, ALLOWED_ORIGIN: 'http://localhost:8080, https://fulano.github.io', TURNSTILE_SECRET: 's', RSVP_TOKEN: 'bot-token', SUPERADMIN_USER: 'chefe', SUPERADMIN_PASS: 'senha-super-123', DISCORD_WEBHOOK: 'https://discord.test/hook' };
const discordCalls = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('turnstile')) return Response.json({ success: init.body.get('response') === 'ok' });
  discordCalls.push(JSON.parse(init.body.get('payload_json')));
  return new Response(null, { status: 204 });
};
const ctx = { waitUntil: (p) => p };

async function call(method, path, { body, token, ip = '1.1.1.1' } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (token) headers.authorization = 'Bearer ' + token;
  if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const res = await worker.fetch(new Request('http://w' + path, { method, headers, body }), env, ctx);
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}
function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, x);
  return fd;
}
const reg = (extra = {}) => form({ 'cf-turnstile-response': 'ok', nick: 'Fulano', discord: '@fulano', pais: 'Brasil', fuso: 'GMT-3', dias: ['qui', 'sex'], sobre: 'Jogo toda noite', regras: 'sim', ...extra });

// envios públicos
let r = await call('POST', '/api/register', { body: reg({ 'cf-turnstile-response': 'x' }) });
assert.equal(r.status, 403, 'captcha inválido');
r = await call('POST', '/api/register', { body: reg() });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8080');
const cors = async (origin) => (await worker.fetch(new Request('http://w/api/config', { headers: { origin } }), env, ctx)).headers.get('access-control-allow-origin');
assert.equal(await cors('https://fulano.github.io'), 'https://fulano.github.io', 'segundo endereço liberado');
assert.equal(await cors('https://site-estranho.com'), 'http://localhost:8080', 'endereço estranho não é ecoado');
assert.deepEqual(discordCalls[0].allowed_mentions, { parse: [] });
assert.equal((await call('POST', '/api/register', { body: reg(), ip: '2.2.2.2' })).status, 409, 'nick repetido');
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'B', sobre: 'entra discord.gg/abc' }), ip: '3.3.3.3' })).status, 400, 'link');
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'C', sobre: 'oi @everyone' }), ip: '3.3.3.3' })).status, 400, '@everyone');
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'D', regras: '' }), ip: '3.3.3.3' })).status, 400, 'regras');
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'F', fuso: 'Brasília' }), ip: '3.3.3.3' })).status, 400, 'fuso fora do formato GMT');
const fake = new File([new TextEncoder().encode('<script>alert(1)</script>')], 'x.png', { type: 'image/png' });
assert.equal((await call('POST', '/api/gear', { body: form({ 'cf-turnstile-response': 'ok', nick: 'Fulano', prints: fake }), ip: '4.4.4.4' })).status, 400, 'arquivo que não é imagem');
// cabeçalho PNG de verdade (assinatura + IHDR com largura/altura), com "tamanho" opcional pra testar o limite de bytes
function pngFile(w, h, bytes = 64) {
  const b = new Uint8Array(bytes);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return new File([b], 'a.png');
}
const png = pngFile(800, 600);
assert.equal((await call('POST', '/api/gear', { body: form({ 'cf-turnstile-response': 'ok', nick: 'Fulano', gear: 'AK nova', prints: png }), ip: '4.4.4.4' })).status, 200);
for (const nick of ['E1', 'E2']) assert.equal((await call('POST', '/api/register', { body: reg({ nick }), ip: '5.5.5.5' })).status, 200);
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'E3' }), ip: '5.5.5.5' })).status, 200);
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'E4' }), ip: '5.5.5.5' })).status, 429, '4º envio na hora');

// rsvp
assert.equal((await call('POST', '/api/rsvp', { body: { date: '2026-11-21', nick: 'Fulano', status: 'vai' } })).status, 401);
assert.equal((await call('POST', '/api/rsvp', { body: { date: '2026-11-21', nick: 'Fulano', status: 'vai' }, token: 'bot-token' })).status, 200);

// superadmin cria squad e equipe
const sup = (await call('POST', '/api/admin/login', { body: { user: 'Chefe', pass: 'senha-super-123' } })).data.token;
const sqA = (await call('POST', '/api/admin/squad', { body: { nome: 'Alfa' }, token: sup })).data;
const sqB = (await call('POST', '/api/admin/squad', { body: { nome: 'Bravo' }, token: sup })).data;
assert.equal((await call('POST', '/api/admin/user', { body: { novo: true, name: 'sn', role: 'admin', senha: 'provisoria1' }, token: sup })).status, 200);
assert.equal((await call('POST', '/api/admin/user', { body: { novo: true, name: 'chefe', role: 'admin', senha: 'provisoria1' }, token: sup })).status, 400, 'não recria o superadmin');
assert.equal((await call('POST', '/api/admin/user', { body: { novo: true, name: 'lid', role: 'lider_squad', squad: sqA.id, senha: 'provisoria2' }, token: sup })).status, 200);
const users = (await call('GET', '/api/admin/users', { token: sup })).data;
assert.ok(users.every((x) => !x.hash && !x.salt), 'hash não sai na API');

// troca de senha obrigatória
let sn = (await call('POST', '/api/admin/login', { body: { user: 'sn', pass: 'provisoria1' } })).data;
assert.equal(sn.mustChange, true);
assert.equal((await call('GET', '/api/admin/members', { token: sn.token })).status, 403);
sn = (await call('POST', '/api/admin/password', { body: { atual: 'provisoria1', nova: 'nova-senha-sn' }, token: sn.token })).data;
assert.equal((await call('GET', '/api/admin/members', { token: sn.token })).status, 200);

// admin não mexe em equipe/config/log
assert.equal((await call('GET', '/api/admin/users', { token: sn.token })).status, 403);
assert.equal((await call('POST', '/api/admin/config', { body: { regras: 'x' }, token: sn.token })).status, 403);
assert.equal((await call('GET', '/api/admin/log', { token: sn.token })).status, 403);

// líder só vê o próprio squad
const members = (await call('GET', '/api/admin/members', { token: sn.token })).data;
const [m1, m2] = members;
await call('POST', '/api/admin/squad', { body: { id: sqA.id, nome: 'Alfa', fixos: [m1.id] }, token: sn.token });
await call('POST', '/api/admin/squad', { body: { id: sqB.id, nome: 'Bravo', fixos: [m2.id] }, token: sn.token });
let lid = (await call('POST', '/api/admin/login', { body: { user: 'lid', pass: 'provisoria2' } })).data;
lid = (await call('POST', '/api/admin/password', { body: { atual: 'provisoria2', nova: 'nova-senha-lid' }, token: lid.token })).data;
const seen = (await call('GET', '/api/admin/members', { token: lid.token })).data;
assert.deepEqual(seen.map((x) => x.id), [m1.id]);
assert.equal((await call('POST', '/api/admin/member', { body: { id: m2.id, nota: 3 }, token: lid.token })).status, 404, 'membro de outro squad');
r = await call('POST', '/api/admin/member', { body: { id: m1.id, nota: 8, status: 'removido', squad: '' }, token: lid.token });
assert.equal(r.data.nota, 8);
assert.equal(r.data.status, 'teste', 'líder não muda status');
assert.equal(r.data.squad, sqA.id, 'líder não muda squad');
await call('POST', '/api/admin/attendance', { body: { date: '2026-11-21', marks: { [m1.id]: { s: 'faltou' }, [m2.id]: { s: 'faltou' } } }, token: lid.token });
const att = (await call('GET', '/api/admin/attendance', { token: sn.token })).data[0];
assert.deepEqual(Object.keys(att.marks), [m1.id], 'líder não marca outro squad');
// ocorrência sem status, ligada à 2ª guerra; g inválido vira "dia todo"
await call('POST', '/api/admin/attendance', { body: { date: '2026-11-21', marks: { [m1.id]: { s: 'faltou', o: [{ g: '2', t: 'Deu que ia e não veio' }, { g: '9', t: 'AFK farmando ponto' }, { g: '1', t: '' }] } } }, token: lid.token });
await call('POST', '/api/admin/attendance', { body: { date: '2026-11-28', marks: { [m1.id]: { s: '', o: [{ g: '3', t: 'Saiu no meio' }] } } }, token: lid.token });
const atts = (await call('GET', '/api/admin/attendance', { token: sn.token })).data;
assert.deepEqual(atts.find((a) => a.date === '2026-11-21').marks[m1.id].o, [{ g: '2', t: 'Deu que ia e não veio' }, { g: '', t: 'AFK farmando ponto' }]);
assert.deepEqual(atts.find((a) => a.date === '2026-11-28').marks[m1.id], { s: '', j: '', o: [{ g: '3', t: 'Saiu no meio' }] }, 'ocorrência sem status é guardada');
assert.equal((await call('POST', '/api/admin/squad', { body: { nome: 'X' }, token: lid.token })).status, 403);
assert.equal((await call('GET', '/api/admin/posts', { token: lid.token })).status, 403);
assert.equal((await call('GET', '/api/admin/backup', { token: lid.token })).status, 403);

// registro escolhendo o squad Alfa vira pedido; o líder vê a ficha do candidato sem avaliações, mas não edita
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'Novato', squad: sqA.id }), ip: '7.7.7.7' })).status, 200);
const novato = (await call('GET', '/api/admin/members', { token: sn.token })).data.find((m) => m.nick === 'Novato');
await call('POST', '/api/admin/member', { body: { id: novato.id, nota: 9, anotacoes: 'segredo do admin' }, token: sn.token });
const pedido = (await call('GET', '/api/admin/applies', { token: lid.token })).data.find((a) => a.nick === 'Novato');
assert.equal(pedido.origem, 'registro');
const vistoPeloLider = (await call('GET', '/api/admin/members', { token: lid.token })).data.find((m) => m.nick === 'Novato');
assert.equal(vistoPeloLider.candidato, true);
assert.equal(vistoPeloLider.anotacoes, '', 'líder não vê anotações de candidato');
assert.equal(vistoPeloLider.nota, null);
assert.equal((await call('POST', '/api/admin/member', { body: { id: novato.id, nota: 2 }, token: lid.token })).status, 404, 'líder não edita candidato');
assert.equal((await call('POST', '/api/admin/attendance', { body: { date: '2026-11-21', marks: { [novato.id]: { s: 'faltou' } } }, token: lid.token })).status, 200);
assert.equal((await call('GET', '/api/admin/attendance', { token: sn.token })).data.find((a) => a.date === '2026-11-21').marks[novato.id], undefined, 'líder não marca candidato');
// aceitar coloca no squad como fixo; líder muda pra reserva e o site mostra separado
await call('POST', '/api/admin/apply', { body: { id: pedido.id, aceitar: true }, token: lid.token });
assert.equal((await call('POST', '/api/admin/member', { body: { id: novato.id, vaga: 'reserva' }, token: lid.token })).data.vaga, 'reserva');
assert.equal((await call('POST', '/api/admin/member', { body: { id: novato.id, vaga: 'capitao' }, token: lid.token })).status, 400);
const alfaPublico = (await call('GET', '/api/squads')).data.find((s) => s.id === sqA.id);
assert.deepEqual([alfaPublico.fixos, alfaPublico.reservas], [[m1.nick], ['Novato']]);

// webhook pelo painel: admin salva, link nunca volta inteiro, líder não acessa, fica fora do backup
assert.equal((await call('POST', '/api/admin/webhook', { body: { url: 'https://evil.example/x' }, token: sn.token })).status, 400);
assert.equal((await call('POST', '/api/admin/webhook', { body: { url: 'https://discord.com/api/webhooks/123/abc-XYZ' }, token: sn.token })).status, 200);
assert.deepEqual((await call('GET', '/api/admin/webhook', { token: sn.token })).data, { configurado: true, final: '-XYZ' });
assert.equal((await call('GET', '/api/admin/webhook', { token: lid.token })).status, 403);
discordCalls.length = 0;
assert.equal((await call('POST', '/api/admin/webhook-teste', { token: sn.token })).status, 200);
assert.equal(discordCalls[0].embeds[0].title, 'Teste do site do clã');
assert.equal((await call('GET', '/api/admin/backup', { token: sn.token })).data.webhook, undefined);

// seasons: só superadmin; a config muda só o que veio
assert.equal((await call('POST', '/api/admin/config', { body: { seasons: [] }, token: sn.token })).status, 403);
assert.equal((await call('POST', '/api/admin/config', { body: { seasons: [{ nome: 'S1', inicio: '2026-11-30', fim: '2026-11-01' }] }, token: sup })).status, 400, 'fim antes do início');
await call('POST', '/api/admin/config', { body: { seasons: [{ nome: 'S1', inicio: '2026-11-01', fim: '2026-11-30' }, { nome: 'S2', inicio: '2026-12-01', fim: '2026-12-31' }], seasonAtualNome: 'S1' }, token: sup });
let cfgS = (await call('GET', '/api/config')).data;
const [s1, s2] = cfgS.seasons;
assert.equal(cfgS.seasonAtual, s1.id);
assert.ok(cfgS.playstyles.length && cfgS.horario, 'salvar seasons não apaga o resto da config');
assert.deepEqual(cfgS.gearTipos, ['Speed', 'Tank', 'Híbrido']);

// tipo de gear no registro e no gear; registro guarda a season
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'G1', gearTipo: 'Voador' }), ip: '8.8.8.1' })).status, 400, 'tipo de gear fora da config');
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'G1', gearTipo: ['Tank', 'Speed'] }), ip: '8.8.8.1' })).status, 200);
assert.equal((await call('POST', '/api/gear', { body: form({ 'cf-turnstile-response': 'ok', nick: 'G1', gearTipo: 'Híbrido' }), ip: '8.8.8.2' })).status, 200, 'gear só com tipo');
const g1 = (await call('GET', '/api/admin/members', { token: sup })).data.find((m) => m.nick === 'G1');
assert.deepEqual(g1.gearTipos, ['Híbrido']);
assert.deepEqual(g1.gear.map((g) => g.tipos), [['Tank', 'Speed'], ['Híbrido']]);

// admin edita registro e gear; líder não
assert.equal((await call('POST', '/api/admin/member', { body: { id: g1.id, dados: { ...g1, nick: 'G1novo', fuso: 'GMT+1' } }, token: sup })).data.nick, 'G1novo');
assert.equal((await call('POST', '/api/admin/member', { body: { id: g1.id, dados: { ...g1, nick: 'Fulano', fuso: 'GMT+1' } }, token: sup })).status, 409, 'nick repetido');
assert.equal((await call('POST', '/api/admin/member', { body: { id: g1.id, gearEdit: { idx: 0, texto: 'corrigido', tipos: ['Speed'] } }, token: sup })).data.gear[0].texto, 'corrigido');
assert.equal((await call('POST', '/api/admin/member', { body: { id: g1.id, gearEdit: { idx: 1, remover: true } }, token: sup })).data.gear.length, 1);
const lid2 = (await call('POST', '/api/admin/login', { body: { user: 'lid', pass: 'nova-senha-lid' } })).data.token;
const m1Antes = (await call('GET', '/api/admin/members', { token: sup })).data.find((m) => m.id === m1.id);
await call('POST', '/api/admin/member', { body: { id: m1.id, dados: { ...m1Antes, nick: 'Hackeado' } }, token: lid2 });
assert.equal((await call('GET', '/api/admin/members', { token: sup })).data.find((m) => m.id === m1.id).nick, m1Antes.nick, 'líder não edita registro');

// builds procuradas: líder edita o próprio squad, não o dos outros; aparece no público
assert.equal((await call('POST', '/api/admin/squad-procura', { body: { id: sqA.id, builds: [{ tipo: 'Tank', qtd: 2 }, { tipo: 'Speed' }, { tipo: 'Tank', qtd: 5 }], funcoes: ['Sniper'] }, token: lid2 })).status, 200);
assert.equal((await call('POST', '/api/admin/squad-procura', { body: { id: sqB.id, builds: [] }, token: lid2 })).status, 403);
const alfaPub = (await call('GET', '/api/squads')).data.find((s) => s.id === sqA.id);
assert.deepEqual(alfaPub.builds, [{ tipo: 'Tank', qtd: 2 }, { tipo: 'Speed', qtd: null }]);
assert.deepEqual(alfaPub.funcoes, ['Sniper']);

// resultados: IA desligada → 502; IA que responde lixo → 502; IA boa → linhas
const fd4 = new FormData(); fd4.append('prints', png);
const [printId] = (await call('POST', '/api/admin/upload-placar', { body: fd4, token: lid2 })).data;
assert.ok(store.get('img:' + printId), 'print salva');
assert.equal((await call('POST', '/api/admin/ler-placar', { body: { ids: [printId] }, token: sup })).status, 502, 'sem binding AI');
env.AI = { run: async () => ({ response: 'não sei ler isso' }) };
assert.equal((await call('POST', '/api/admin/ler-placar', { body: { ids: [printId] }, token: sup })).status, 502, 'IA sem JSON');
let pedidoIA = null;
env.AI = { run: async (modelo, inp) => {
  pedidoIA = { modelo, inp };
  return { response: 'Aqui: [{"nick":"[Made in Brazil] Fulano","kills":10,"deaths":2,"assists":4},{"nick":"Inimigo","kills":"3","deaths":5,"assists":-1}]' };
} };
const lidas = (await call('POST', '/api/admin/ler-placar', { body: { ids: [printId, printId] }, token: sup })).data;
assert.deepEqual(lidas, [{ nick: 'Fulano', kills: 10, deaths: 2, assists: 4 }, { nick: 'Inimigo', kills: 3, deaths: 5, assists: 0 }], 'tira a tag do clã, limpa números e tira repetidos');
assert.equal(pedidoIA.modelo, '@cf/meta/llama-4-scout-17b-16e-instruct');
assert.ok(pedidoIA.inp.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,iVBORw0KGgo'), 'imagem vai como data URL com o tipo certo');
delete env.AI;

// salvar: admin salva tudo; líder só mexe no próprio squad e não apaga linhas dos outros
const novatoId = (await call('GET', '/api/admin/members', { token: sup })).data.find((m) => m.nick === 'Novato').id;
await call('POST', '/api/admin/result', { body: { date: '2026-11-19', game: 2, modo: 'Torneio', linhas: [{ memberId: m1.id, kills: 10, deaths: 2, assists: 4 }, { memberId: m2.id, kills: 1, deaths: 9, assists: 0 }], prints: [printId] }, token: sup });
let res = (await call('GET', '/api/admin/results', { token: sup })).data[0];
assert.equal(res.season, s1.id);
assert.equal(res.linhas.length, 2);
await call('POST', '/api/admin/result', { body: { date: '2026-11-19', game: 2, linhas: [{ memberId: novatoId, kills: 5, deaths: 0, assists: 1 }, { memberId: m2.id, kills: 99, deaths: 0, assists: 0 }] }, token: lid2 });
res = (await call('GET', '/api/admin/results', { token: sup })).data[0];
assert.deepEqual(res.linhas.map((l) => [l.nick, l.kills]).sort(), [[m2.nick, 1], ['Novato', 5]].sort(), 'líder trocou só o squad dele e não mexeu no m2');
assert.equal(res.modo, 'Torneio', 'modo mantido');
const resLider = (await call('GET', '/api/admin/results', { token: lid2 })).data[0];
assert.deepEqual(resLider.linhas.map((l) => l.nick), ['Novato'], 'líder só vê o próprio squad');
assert.equal((await call('POST', '/api/admin/result', { body: { date: '2026-11-19', game: 4, linhas: [] }, token: sup })).status, 400);
assert.equal((await call('DELETE', '/api/admin/result?date=2026-11-19&game=2', { token: lid2 })).status, 403);
assert.ok(Object.keys((await call('GET', '/api/admin/backup', { token: sup })).data).includes('res:2026-11-19:2'), 'resultado no backup');
await call('POST', '/api/admin/attendance', { body: { date: '2026-12-05', marks: { [novatoId]: { s: 'presente' } } }, token: lid2 });
assert.equal((await call('GET', '/api/admin/attendance', { token: sup })).data.find((a) => a.date === '2026-12-05').season, s2.id, 'presença guarda a season da data');

// ---- limites de imagem (o Worker não confia no navegador) ----
const tentaGear = (file, ip) => call('POST', '/api/gear', { body: form({ 'cf-turnstile-response': 'ok', nick: 'Fulano', prints: file }), ip });
assert.equal((await tentaGear(pngFile(800, 600, 1.2e6), '6.6.6.1')).status, 413, 'imagem acima de 1 MB');
assert.equal((await tentaGear(pngFile(5000, 300), '6.6.6.2')).status, 413, 'lado acima de 4096px');
assert.equal((await tentaGear(pngFile(0, 0), '6.6.6.3')).status, 400, 'dimensão ilegível');
const cinco = Array.from({ length: 5 }, () => pngFile(800, 600));
assert.equal((await call('POST', '/api/gear', { body: form({ 'cf-turnstile-response': 'ok', nick: 'Fulano', prints: cinco }), ip: '6.6.6.4' })).status, 400, 'mais de 4 imagens');
const seis = Array.from({ length: 6 }, () => pngFile(800, 600, 900e3));
const fd6 = new FormData(); seis.forEach((f) => fd6.append('prints', f));
assert.equal((await call('POST', '/api/admin/upload', { body: fd6, token: sup })).status, 413, 'soma acima de 5 MB');
assert.equal((await call('POST', '/api/admin/post', { body: { titulo: 'Muitas', imgs: Array.from({ length: 9 }, () => crypto.randomUUID()) }, token: sup })).status, 400, 'post com mais de 8 imagens');
// jpeg e webp: dimensões lidas do cabeçalho
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x13, 0x88, 0x01, 0x00, 3, 0, 0, 0]); // 256x5000
assert.equal((await tentaGear(new File([jpg], 'a.jpg'), '6.6.6.5')).status, 413, 'jpeg alto demais');
const webp = new Uint8Array(40); webp.set([...'RIFF'].map((c) => c.charCodeAt(0))); webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
new DataView(webp.buffer).setUint32(24, 799, true); new DataView(webp.buffer).setUint32(27, 599, true);
assert.equal((await call('POST', '/api/gear', { body: form({ 'cf-turnstile-response': 'ok', nick: 'Fulano', gear: 'webp ok', prints: new File([webp], 'a.webp') }), ip: '6.6.6.6' })).status, 200, 'webp 800x600 aceito');

// ---- prints de gear antigas expiram em 60 dias; as da última ficam sem prazo ----
const ttls = {};
const putOriginal = KV.put;
KV.put = async (k, v, o) => { if (k.startsWith('img:')) ttls[k] = o?.expirationTtl; return putOriginal(k, v, o); };
await call('POST', '/api/gear', { body: form({ 'cf-turnstile-response': 'ok', nick: 'Fulano', prints: pngFile(640, 480) }), ip: '6.6.6.7' });
KV.put = putOriginal;
const fulanoG = (await call('GET', '/api/admin/members', { token: sup })).data.find((m) => m.nick === 'Fulano');
const [penultimo, ultimo] = fulanoG.gear.slice(-2);
assert.ok(penultimo.expira, 'atualização anterior marcada pra expirar');
assert.ok(penultimo.imgs.every((i) => ttls['img:' + i] === 60 * 86400), 'prints anteriores com TTL de 60 dias');
assert.ok(ultimo.imgs.every((i) => ttls['img:' + i] === undefined) && !ultimo.expira, 'prints da última sem prazo');

// ---- Discord: interruptores, anti-repost, divisão de embed grande, justificativa nunca vai ----
await call('POST', '/api/admin/webhook', { body: { url: 'https://discord.com/api/webhooks/1/abc' }, token: sup });
assert.equal((await call('POST', '/api/admin/discord-config', { body: { discord: { kdGame: true } }, token: lid2 })).status, 403, 'líder não mexe');
discordCalls.length = 0;
await call('POST', '/api/admin/discord-config', { body: { discord: { registro: false } }, token: sup });
await call('POST', '/api/register', { body: reg({ nick: 'Desligado' }), ip: '6.6.6.8' });
assert.equal(discordCalls.length, 0, 'registro desligado não posta');
await call('POST', '/api/admin/discord-config', { body: { discord: { registro: true, kdGame: true, kdDia: true, presenca: true } }, token: sup });
const salvarG3 = () => call('POST', '/api/admin/result', { body: { date: '2026-11-21', game: 3, modo: 'Torneio', linhas: [{ memberId: m2.id, kills: 7, deaths: 1, assists: 2 }] }, token: sup });
discordCalls.length = 0;
let rG3 = (await salvarG3()).data;
assert.deepEqual(rG3.discord, { kdGame: 'postado', kdDia: 'postado' }, 'game 3 posta o game e o dia');
assert.equal(discordCalls.length, 2);
assert.ok(discordCalls[0].embeds[0].fields[0].value.startsWith('Kill (7) / Death (1) / Assist (2) / Rating (9.00)'));
rG3 = (await salvarG3()).data;
assert.deepEqual(rG3.discord, { kdGame: 'ja', kdDia: 'ja' }, 'salvar de novo não reposta');
assert.equal(discordCalls.length, 2);
discordCalls.length = 0;
await call('POST', '/api/admin/attendance', { body: { date: '2026-11-22', marks: { [m2.id]: { s: 'justificou', j: 'SEGREDO-DA-JUSTIFICATIVA' } } }, token: sup });
assert.ok(discordCalls.length === 1 && !JSON.stringify(discordCalls).includes('SEGREDO'), 'presença posta só nomes');
// prévia não envia; postar envia, marca e vai pro log
discordCalls.length = 0;
const previa = (await call('POST', '/api/admin/discord-postar', { body: { tipo: 'kdGame', date: '2026-11-21', game: 3, previa: true }, token: sn.token })).data;
assert.ok(Array.isArray(previa) && discordCalls.length === 0, 'prévia não envia');
assert.equal((await call('POST', '/api/admin/discord-postar', { body: { tipo: 'semana' }, token: lid2 })).status, 403, 'líder não posta');
assert.equal((await call('POST', '/api/admin/discord-postar', { body: { tipo: 'ranking' }, token: sup })).data.ok, true);
// embed grande é dividido (60 jogadores = 3 mensagens de até 25 campos)
const muitos = Array.from({ length: 60 }, (_, i) => ['Jogador ' + i, 'Kill (1) / Death (1) / Assist (1) / Rating (2.00)']);
discordCalls.length = 0;
const nomes = Object.fromEntries(muitos.map(([n], i) => ['id' + i, n]));
store.set('att:2026-10-10', { v: JSON.stringify({ date: '2026-10-10', marks: Object.fromEntries(Object.keys(nomes).map((id) => [id, { s: 'presente' }])) }) });
for (const [id, nick] of Object.entries(nomes)) store.set('member:' + id, { v: JSON.stringify({ id, nick, status: 'membro', squad: '', dias: [], tags: [], gear: [], criadoEm: '2026-10-01T00:00:00Z' }) });
await call('POST', '/api/admin/discord-postar', { body: { tipo: 'presenca', date: '2026-10-10' }, token: sup });
assert.ok(discordCalls.every((c) => c.embeds[0].fields.length <= 25 && JSON.stringify(c.embeds[0]).length < 6000), 'cada mensagem dentro do limite do Discord');

// ---- cron e backup de teste ----
const fetchAntes = discordCalls.length;
await worker.scheduled({}, env, ctx);
assert.equal(discordCalls.length, fetchAntes, 'cron sem DISCORD_BACKUP_WEBHOOK não faz nada');
assert.equal((await call('POST', '/api/admin/backup-teste', { token: sup })).status, 400, 'teste sem secret avisa');
assert.equal((await call('POST', '/api/admin/backup-teste', { token: sn.token })).status, 403, 'só superadmin');
let backupEnviado = null;
const fetchMock = globalThis.fetch;
globalThis.fetch = async (url, init) => { if (String(url).includes('backup')) { backupEnviado = await init.body.get('files[0]').text(); return new Response(null, { status: 204 }); } return fetchMock(url, init); };
env.DISCORD_BACKUP_WEBHOOK = 'https://discord.com/api/webhooks/9/backup';
await worker.scheduled({}, env, { waitUntil: (p) => p });
await new Promise((r) => setTimeout(r, 50));
assert.ok(backupEnviado && JSON.parse(backupEnviado).config, 'cron manda o JSON do backup');
assert.ok(!Object.keys(JSON.parse(backupEnviado)).some((k) => /^(user|sess|img|uso):/.test(k)), 'backup sem usuários, sessões, imagens');
delete env.DISCORD_BACKUP_WEBHOOK;
globalThis.fetch = fetchMock;

// ---- contador de gravações do dia (só superadmin) ----
const uso = (await call('GET', '/api/admin/uso', { token: sup })).data;
assert.ok(uso.hoje > 0 && uso.limite === 1000, 'contador conta gravações');
assert.equal((await call('GET', '/api/admin/uso', { token: sn.token })).status, 403);

// ---- tirar do squad e apagar membro ----
const membrosAgora = (await call('GET', '/api/admin/members', { token: sup })).data;
const doAlfa = membrosAgora.find((m) => m.squad === sqA.id);
const doBravo = membrosAgora.find((m) => m.squad === sqB.id);
assert.equal((await call('POST', '/api/admin/member', { body: { id: doBravo.id, tirarDoSquad: true }, token: lid2 })).status, 404, 'líder não tira de outro squad');
assert.equal((await call('POST', '/api/admin/member', { body: { id: doAlfa.id, tirarDoSquad: true }, token: lid2 })).data.squad, '', 'líder tira do próprio squad');
assert.ok(!(await call('GET', '/api/squads')).data.find((s) => s.id === sqA.id).fixos.includes(doAlfa.nick), 'saiu da lista pública');
assert.equal((await call('DELETE', `/api/admin/member?id=${doBravo.id}`, { token: lid2 })).status, 403, 'líder não apaga membro');
assert.equal((await call('DELETE', `/api/admin/member?id=${doBravo.id}`, { token: sup })).status, 200);
assert.ok(!(await call('GET', '/api/admin/members', { token: sup })).data.some((m) => m.id === doBravo.id), 'membro apagado');
assert.equal(store.get('nick:' + doBravo.nick.toLowerCase()), undefined, 'nick liberado');
assert.ok(!(await call('GET', '/api/squads')).data.find((s) => s.id === sqB.id).fixos.includes(doBravo.nick), 'sumiu do squad');
assert.equal((await call('POST', '/api/register', { body: reg({ nick: doBravo.nick }), ip: '5.4.3.2' })).status, 200, 'nick pode registrar de novo');

// trocar cargo derruba a sessão
await call('POST', '/api/admin/user', { body: { name: 'sn', role: 'lider_squad', squad: sqB.id }, token: sup });
assert.equal((await call('GET', '/api/admin/me', { token: sn.token })).status, 401);
// remover derruba a sessão
await call('DELETE', '/api/admin/user?name=lid', { token: sup });
assert.equal((await call('GET', '/api/admin/me', { token: lid.token })).status, 401);

// bloqueio depois de 5 erros
for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/admin/login', { body: { user: 'chefe', pass: 'errada' } })).status, 401);
assert.equal((await call('POST', '/api/admin/login', { body: { user: 'chefe', pass: 'senha-super-123' } })).status, 429);

// backup não leva usuários nem sessões, e importação recusa chave de usuário
const backup = (await call('GET', '/api/admin/backup', { token: sup })).data;
assert.ok(Object.keys(backup).every((k) => !/^(user|sess|fail|rl|img):/.test(k)));
assert.equal((await call('POST', '/api/admin/backup', { body: { 'user:hacker': {} }, token: sup })).status, 400);

// funções no squad, config com descrição, avisos separados das táticas
await call('POST', '/api/admin/squad', { body: { id: sqA.id, nome: 'Alfa', funcoes: ['Sniper', 'Tank', 'Sniper'] }, token: sup });
assert.deepEqual((await call('GET', '/api/squads')).data.find((s) => s.id === sqA.id).funcoes, ['Sniper', 'Tank']);
await call('POST', '/api/admin/config', { body: { horario: '21:00', regras: 'r', playstyles: [{ nome: 'Livre', desc: 'Roda o mapa' }, { nome: '' }] }, token: sup });
const cfg = (await call('GET', '/api/config')).data;
assert.deepEqual(cfg.playstyles, [{ nome: 'Livre', desc: 'Roda o mapa' }]);
await call('POST', '/api/admin/post', { body: { titulo: 'Guerra adiada', tipo: 'aviso', publico: true }, token: sup });
await call('POST', '/api/admin/post', { body: { titulo: 'Rota B', publico: true }, token: sup });
await call('POST', '/api/admin/post', { body: { titulo: 'Segredo', tipo: 'aviso', publico: false }, token: sup });
assert.deepEqual((await call('GET', '/api/posts?tipo=aviso')).data.map((p) => p.titulo), ['Guerra adiada']);
assert.deepEqual((await call('GET', '/api/posts')).data.map((p) => p.titulo), ['Rota B']);
const fulano = (await call('GET', '/api/admin/members', { token: sup })).data.find((m) => m.nick === 'Fulano');
assert.equal(fulano.cla, 'nao');
assert.equal(fulano.sobre, 'Jogo toda noite');
assert.equal((await call('POST', '/api/register', { body: reg({ nick: 'SemSobre', sobre: '' }), ip: '9.9.9.9' })).status, 200, 'sobre opcional');

const log = (await call('GET', '/api/admin/log', { token: sup })).data;
assert.ok(log.some((l) => l.texto === `marcou falta em ${m1.nick} em 21/11/2026`), 'log de presença');
console.log('ok: todos os testes passaram');
