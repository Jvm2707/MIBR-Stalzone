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
const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], 'a.png');
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
