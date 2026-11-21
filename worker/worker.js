// Worker do clã: API REST + KV. Todo segredo vem de env (secrets), nada no site.
// Chaves no KV:
//   config, tags, member:<id>, nick:<nick minúsculo> -> id, squad:<id>, apply:<id>,
//   post:<id>, att:<data>, rsvp:<data>:<nick>, img:<id>, user:<nome>, sess:<token>,
//   fail:<nome> (tentativas de login), rl:<ip>:<hora> (limite por IP), log:<ordem>

const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
const STATUS = ['teste', 'membro', 'veterano', 'removido'];
const ATT = { presente: 'presença', faltou: 'falta', justificou: 'falta justificada' };
const RSVP = ['vai', 'talvez', 'nao'];
const ROLES = ['admin', 'lider_squad'];
const MAX_POR_HORA = 3;
// Links, convites e menções em massa ficam de fora de qualquer texto público.
const PROIBIDO = /https?:|www\.|t\.me|telegram|discord\.gg|discord(app)?\.com\/invite|@everyone|@here/i;
const DEFAULT_CONFIG = {
  horario: '21:00 (Brasília). Vira 22:00 quando os EUA estão no horário de verão.',
  regras: 'As regras ainda não foram publicadas.',
  playstyles: [
    // mesmos textos da lista padrão em site/index.html
    { nome: 'Livre', desc: 'Não fica preso a um lugar: roda o mapa e aparece onde o time mais precisa, seja fechando um buraco, cobrindo um aliado ou ajudando a virar uma luta.' },
    { nome: 'Suporte', desc: 'Acompanha um squad num ponto importante e deixa o trabalho dele mais fácil: joga granada, constrói defesas e segura a posição junto.' },
    { nome: 'Sniper', desc: 'Joga à distância: controla as linhas de visão, avisa onde o inimigo está e derruba quem tenta atravessar.' },
    { nome: 'Tank', desc: 'Escolhe um lugar e não sai dele: segura o ponto, aguenta a pressão e é o último a cair.' },
  ],
};
const TIPOS_POST = ['tatica', 'aviso'];
const DEFAULT_TAGS = ['bom player', 'promessa', 'tóxico'];

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const clip = (v, max) => String(v ?? '').trim().slice(0, max);
const uuid = () => crypto.randomUUID();
const isId = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const brDate = (d) => d.split('-').reverse().join('/');

const getJ = (env, k) => env.KV.get(k, 'json');
const putJ = (env, k, v, opts) => env.KV.put(k, JSON.stringify(v), opts);

// shortcut: lê chave por chave (limite de 1000 operações KV por requisição), ok até algumas centenas de membros.
async function listVals(env, prefix, limit = Infinity) {
  const names = [];
  let cursor;
  do {
    const r = await env.KV.list({ prefix, cursor });
    names.push(...r.keys.map((k) => k.name));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && names.length < limit);
  const vals = await Promise.all(names.slice(0, limit).map((n) => getJ(env, n)));
  return vals.filter(Boolean);
}

export default {
  async fetch(req, env, ctx) {
    // ALLOWED_ORIGIN aceita vários endereços separados por vírgula; devolve o que bateu com o pedido
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim());
    const origin = req.headers.get('origin');
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    let res;
    if (req.method === 'OPTIONS') res = new Response(null, { status: 204 });
    else {
      try {
        res = await route(req, env, ctx);
      } catch (e) {
        if (e instanceof HttpError) res = json({ error: e.message }, e.status);
        else { console.error(e); res = json({ error: 'Erro interno. Tente de novo.' }, 500); }
      }
    }
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    res.headers.set('X-Content-Type-Options', 'nosniff');
    return res;
  },
};

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  if (m === 'GET' && p === '/api/config') return json(await getConfig(env));
  if (m === 'GET' && p === '/api/squads') {
    const squads = await listVals(env, 'squad:');
    return json(squads.map((s) => ({
      id: s.id, nome: s.nome, estilo: s.estilo, lider: s.lider, funcoes: s.funcoes || [],
      fixos: s.fixos.filter((f) => !f.reserva).map((f) => f.nick),
      reservas: s.fixos.filter((f) => f.reserva).map((f) => f.nick),
    })));
  }
  if (m === 'GET' && p === '/api/posts') {
    const tipo = url.searchParams.get('tipo') === 'aviso' ? 'aviso' : 'tatica';
    const posts = (await listVals(env, 'post:')).filter((x) => x.publico && (x.tipo || 'tatica') === tipo);
    return json(posts.sort((a, b) => b.data.localeCompare(a.data)));
  }
  if (m === 'GET' && p.startsWith('/api/img/')) return getImage(env, p.slice(9));
  if (m === 'POST' && ['/api/register', '/api/gear', '/api/apply'].includes(p)) return publicSubmit(p.slice(5), req, env, ctx);
  if (m === 'POST' && p === '/api/rsvp') return rsvp(req, env);
  if (m === 'POST' && p === '/api/admin/login') return login(req, env);
  if (p.startsWith('/api/admin/')) return admin(req, env, p.slice(11), m, url);
  fail(404, 'Rota não encontrada.');
}

async function getConfig(env) {
  return { ...DEFAULT_CONFIG, ...(await getJ(env, 'config')) };
}

async function getImage(env, id) {
  if (!isId(id)) fail(404, 'Imagem não encontrada.');
  // shortcut: imagens de post privado também saem por aqui, protegidas só pelo id aleatório; mover pra rota com login se virar problema.
  const { value, metadata } = await env.KV.getWithMetadata('img:' + id, 'arrayBuffer');
  if (!value) fail(404, 'Imagem não encontrada.');
  return new Response(value, {
    headers: { 'content-type': metadata.type, 'cache-control': 'public, max-age=31536000, immutable' },
  });
}

// ---------- envios públicos ----------

function txt(fd, name, label, max, required = false) {
  const v = String(fd.get(name) ?? '').trim();
  if (required && !v) fail(400, `Preencha o campo "${label}".`);
  if (v.length > max) fail(400, `O campo "${label}" passou de ${max} caracteres.`);
  if (PROIBIDO.test(v)) fail(400, `O campo "${label}" tem link ou @everyone/@here, e isso não é permitido.`);
  return v;
}

function list(fd, name, label, maxItems, maxLen) {
  const vals = fd.getAll(name).map((v) => String(v).trim()).filter(Boolean);
  if (vals.length > maxItems) fail(400, `Opções demais em "${label}".`);
  for (const v of vals) if (v.length > maxLen || PROIBIDO.test(v)) fail(400, `Opção inválida em "${label}".`);
  return [...new Set(vals)];
}

function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  const s = String.fromCharCode(...b.slice(0, 12));
  if (s.startsWith('RIFF') && s.endsWith('WEBP')) return 'image/webp';
  return null;
}

async function readImages(fd, max) {
  const files = fd.getAll('prints').filter((f) => typeof f !== 'string' && f.size);
  if (files.length > max) fail(400, `Máximo de ${max} imagens.`);
  const out = [];
  for (const f of files) {
    if (f.size > 1.5e6) fail(400, 'Cada imagem pode ter no máximo 1 MB.');
    const buf = await f.arrayBuffer();
    const type = sniff(new Uint8Array(buf));
    if (!type) fail(400, 'Só imagens JPG, PNG ou WEBP.');
    out.push({ buf, type });
  }
  return out;
}

const saveImages = (env, imgs) =>
  Promise.all(imgs.map(async (im) => {
    const id = uuid();
    await env.KV.put('img:' + id, im.buf, { metadata: { type: im.type } });
    return id;
  }));

async function checkTurnstile(env, token, ip) {
  if (!token) fail(400, 'Confirme o captcha antes de enviar.');
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token), remoteip: ip }),
  });
  if (!(await r.json()).success) fail(403, 'Captcha inválido ou vencido. Marque de novo e reenvie.');
}

async function publicSubmit(kind, req, env, ctx) {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  if (+req.headers.get('content-length') > 8e6) fail(413, 'Envio grande demais.');
  const fd = await req.formData().catch(() => fail(400, 'Formulário inválido.'));
  await checkTurnstile(env, fd.get('cf-turnstile-response'), ip);

  // shortcut: o KV é eventualmente consistente, então o limite por IP é aproximado; Turnstile é a barreira principal.
  const rk = `rl:${ip}:${Math.floor(Date.now() / 3.6e6)}`;
  const count = +((await env.KV.get(rk)) || 0);
  if (count >= MAX_POR_HORA) fail(429, 'Limite de 3 envios por hora. Tente de novo mais tarde.');

  const res = await (kind === 'register' ? register : kind === 'gear' ? gear : apply)(fd, env, ctx);
  await env.KV.put(rk, String(count + 1), { expirationTtl: 3600 });
  return res;
}

async function register(fd, env, ctx) {
  const nick = txt(fd, 'nick', 'Nick', 32, true);
  const key = 'nick:' + nick.toLowerCase();
  if (await env.KV.get(key)) fail(409, 'Esse nick já está registrado. Pra mandar gear novo, use "Atualizar gear".');
  const idade = txt(fd, 'idade', 'Idade', 3);
  if (idade && !(/^\d+$/.test(idade) && +idade >= 10 && +idade <= 99)) fail(400, 'Idade precisa ser um número entre 10 e 99.');
  if (fd.get('regras') !== 'sim') fail(400, 'Você precisa aceitar as regras do clã.');
  const dias = list(fd, 'dias', 'Dias', 7, 3);
  if (!dias.length || dias.some((d) => !DIAS.includes(d))) fail(400, 'Marque pelo menos um dia em que pode jogar.');
  const fps = fd.get('fps') === 'sim' ? 'sim' : 'nao';
  const cla = fd.get('cla') === 'sim' ? 'sim' : 'nao';
  const fuso = clip(fd.get('fuso'), 9);
  if (!/^GMT[+-]\d{1,2}(:\d{2})?$/.test(fuso)) fail(400, 'Escolha seu fuso horário.');
  const mic = fd.get('mic') === 'sim' ? 'sim' : 'nao';
  const squadDesejado = clip(fd.get('squad'), 36);
  if (squadDesejado && !isId(squadDesejado)) fail(400, 'Squad inválido.');

  const m = {
    id: uuid(),
    nick,
    discord: txt(fd, 'discord', 'Discord', 40, true),
    idade,
    pais: txt(fd, 'pais', 'País', 60, true),
    fuso,
    dias,
    playstyles: list(fd, 'playstyle', 'Função', 10, 40),
    playstyleOutro: txt(fd, 'playstyleOutro', 'Função (outra)', 100),
    squadDesejado,
    cla,
    claQual: txt(fd, 'claQual', 'Quais clãs e por quanto tempo', 200),
    fps,
    fpsQual: txt(fd, 'fpsQual', 'Quais FPS, rank e tempo', 200),
    mic,
    sobre: txt(fd, 'sobre', 'Fale sobre você', 1000),
    criadoEm: new Date().toISOString(),
    status: 'teste',
    squad: '',
    nota: null,
    anotacoes: '',
    tags: [],
    gear: [],
  };
  const gearTxt = txt(fd, 'gear', 'Gear', 1000);
  const imgs = await readImages(fd, 4);
  if (gearTxt || imgs.length) m.gear.push({ data: m.criadoEm, texto: gearTxt, imgs: await saveImages(env, imgs) });

  await putJ(env, 'member:' + m.id, m);
  await putJ(env, key, m.id);

  const sq = squadDesejado && (await getJ(env, 'squad:' + squadDesejado));
  // escolher um squad no registro vira um pedido pro líder, igual a um apply
  if (sq) {
    const id = uuid();
    await putJ(env, 'apply:' + id, { id, squad: sq.id, nick, msg: 'Escolheu este squad no registro.', origem: 'registro', data: m.criadoEm, status: 'pendente' });
  }
  ctx.waitUntil(discord(env, `Novo registro: ${nick}`, [
    ['Discord', m.discord], ['Idade', idade], ['País', m.pais], ['Fuso', fuso],
    ['Dias', dias.join(', ')],
    ['Função', [...m.playstyles, m.playstyleOutro].filter(Boolean).join(', ')],
    ['Squad desejado', sq?.nome],
    ['Já foi de clã no Stalzone', cla === 'sim' ? `Sim: ${m.claQual || '-'}` : 'Não'],
    ['Já jogou FPS', fps === 'sim' ? `Sim: ${m.fpsQual || '-'}` : 'Não'],
    ['Microfone', mic === 'sim' ? 'Sim' : 'Não'], ['Gear', gearTxt], ['Sobre', m.sobre],
  ], imgs).catch((e) => console.error('discord', e)));
  return json({ ok: true });
}

async function gear(fd, env, ctx) {
  const nick = txt(fd, 'nick', 'Nick', 32, true);
  const texto = txt(fd, 'gear', 'Gear', 1000);
  const imgs = await readImages(fd, 4);
  if (!texto && !imgs.length) fail(400, 'Escreva o gear ou mande pelo menos um print.');
  const id = await getJ(env, 'nick:' + nick.toLowerCase());
  const m = id && (await getJ(env, 'member:' + id));
  if (!m) fail(404, 'Nick não encontrado. Faça o registro primeiro.');
  m.gear.push({ data: new Date().toISOString(), texto, imgs: await saveImages(env, imgs) });
  await putJ(env, 'member:' + m.id, m);
  ctx.waitUntil(discord(env, `Gear atualizado: ${m.nick}`, [['Gear', texto]], imgs).catch((e) => console.error('discord', e)));
  return json({ ok: true });
}

async function apply(fd, env, ctx) {
  const squadId = clip(fd.get('squad'), 36);
  const sq = isId(squadId) && (await getJ(env, 'squad:' + squadId));
  if (!sq) fail(400, 'Squad não encontrado.');
  const a = {
    id: uuid(),
    squad: sq.id,
    nick: txt(fd, 'nick', 'Nick', 32, true),
    msg: txt(fd, 'msg', 'Mensagem', 300),
    data: new Date().toISOString(),
    status: 'pendente',
  };
  await putJ(env, 'apply:' + a.id, a);
  ctx.waitUntil(discord(env, `Apply pro squad ${sq.nome}: ${a.nick}`, [['Mensagem', a.msg]], []).catch((e) => console.error('discord', e)));
  return json({ ok: true });
}

// O link salvo pelo painel tem prioridade; o secret DISCORD_WEBHOOK fica como alternativa.
const webhookUrl = async (env) => (await env.KV.get('webhook')) || env.DISCORD_WEBHOOK || '';
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

async function discord(env, title, fields, imgs) {
  const url = await webhookUrl(env);
  if (!url) return;
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({
    allowed_mentions: { parse: [] }, // nunca pinga ninguém
    embeds: [{
      title: title.slice(0, 256),
      color: 0x009c3b,
      fields: fields.filter(([, v]) => v).map(([name, v]) => {
        const value = String(v).slice(0, 1024);
        return { name, value, inline: value.length < 40 };
      }),
      timestamp: new Date().toISOString(),
    }],
  }));
  imgs.forEach((im, i) => fd.append(`files[${i}]`, new Blob([im.buf], { type: im.type }), `print${i + 1}.${im.type.split('/')[1]}`));
  const r = await fetch(url, { method: 'POST', body: fd });
  if (!r.ok) console.error('discord', r.status, await r.text());
  return r.ok;
}

// ---------- RSVP do bot ----------

async function safeEq(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  return crypto.subtle.timingSafeEqual(x, y);
}

async function rsvp(req, env) {
  if (!env.RSVP_TOKEN || !(await safeEq(req.headers.get('authorization') || '', 'Bearer ' + env.RSVP_TOKEN))) fail(401, 'Token inválido.');
  const body = await req.json().catch(() => fail(400, 'JSON inválido.'));
  const items = Array.isArray(body) ? body : [body];
  if (items.length > 200) fail(400, 'Máximo de 200 itens por envio.');
  for (const it of items) {
    const nick = clip(it?.nick, 32);
    if (!isDate(it?.date) || !nick || !RSVP.includes(it?.status)) fail(400, 'Cada item precisa de date (AAAA-MM-DD), nick e status (vai/talvez/nao).');
  }
  await Promise.all(items.map((it) => {
    const nick = clip(it.nick, 32);
    return putJ(env, `rsvp:${it.date}:${nick.toLowerCase()}`, { nick, status: it.status });
  }));
  return json({ ok: true, salvos: items.length });
}

// ---------- login e sessões ----------

async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  // 100000 é o máximo de iterações que o Workers aceita.
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}

const superName = (env) => String(env.SUPERADMIN_USER || '').toLowerCase();
const putUser = (env, { token, ...u }) => putJ(env, 'user:' + u.name, u);

async function newSession(env, u) {
  const token = randHex(32);
  await putJ(env, 'sess:' + token, { name: u.name, ver: u.ver }, { expirationTtl: 7 * 86400 });
  return { token, name: u.name, role: u.role, squad: u.squad || '', mustChange: !!u.mustChange };
}

async function login(req, env) {
  const b = await req.json().catch(() => ({}));
  const name = clip(b.user, 32).toLowerCase();
  const pass = String(b.pass ?? '');
  if (!name || !pass || pass.length > 128) fail(400, 'Informe usuário e senha.');
  if (!superName(env) || !env.SUPERADMIN_PASS) fail(500, 'SUPERADMIN_USER/SUPERADMIN_PASS não configurados no Worker.');
  const fk = 'fail:' + name;
  const fails = +((await env.KV.get(fk)) || 0);
  if (fails >= 5) fail(429, 'Login bloqueado por 15 minutos depois de 5 tentativas erradas.');

  let u, ok;
  if (name === superName(env)) {
    u = { name, role: 'superadmin', ver: 0 };
    await hashPw(pass, '00'); // mesmo tempo de resposta dos outros logins
    ok = await safeEq(pass, env.SUPERADMIN_PASS);
  } else {
    u = await getJ(env, 'user:' + name);
    const h = await hashPw(pass, u?.salt || '00'); // calcula mesmo sem usuário pra não denunciar quem existe
    ok = !!u && (await safeEq(h, u.hash));
  }
  if (!ok) {
    // só conta erro de usuário que existe: nome inventado não gasta as 1000 gravações/dia do KV grátis
    if (u) await env.KV.put(fk, String(fails + 1), { expirationTtl: 900 });
    fail(401, 'Usuário ou senha incorretos.');
  }
  await env.KV.delete(fk);
  return json(await newSession(env, u));
}

async function auth(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!/^[0-9a-f]{64}$/.test(token)) fail(401, 'Faça login.');
  const s = await getJ(env, 'sess:' + token);
  if (!s) fail(401, 'Sessão expirada. Faça login de novo.');
  let u;
  if (superName(env) && s.name === superName(env)) u = { name: s.name, role: 'superadmin', ver: 0 };
  else {
    u = await getJ(env, 'user:' + s.name);
    // usuário removido ou com cargo/senha trocados: a sessão morre aqui
    if (!u || u.ver !== s.ver) {
      await env.KV.delete('sess:' + token);
      fail(401, 'Sessão encerrada. Faça login de novo.');
    }
  }
  u.token = token;
  return u;
}

async function log(env, u, texto) {
  const ordem = String(1e13 - Date.now()).padStart(13, '0'); // mais novo primeiro na listagem
  await putJ(env, `log:${ordem}:${randHex(2)}`, { data: new Date().toISOString(), quem: u.name, texto }, { expirationTtl: 180 * 86400 });
}

// Recalcula a lista pública de fixos dos squads a partir de member.squad (a fonte da verdade).
async function syncSquads(env, ids, members) {
  for (const id of new Set(ids.filter(Boolean))) {
    const sq = await getJ(env, 'squad:' + id);
    if (!sq) continue;
    sq.fixos = members.filter((m) => m.squad === id && m.status !== 'removido')
      .map((m) => ({ id: m.id, nick: m.nick, reserva: m.vaga === 'reserva' }));
    await putJ(env, 'squad:' + id, sq);
  }
}

async function addTags(env, tags) {
  const all = (await getJ(env, 'tags')) || DEFAULT_TAGS;
  const merged = [...new Set([...all, ...tags])];
  if (merged.length !== all.length) await putJ(env, 'tags', merged);
}

const BACKUP_PREFIXES = ['config', 'tags', 'member:', 'nick:', 'squad:', 'apply:', 'post:', 'att:', 'rsvp:', 'log:'];

// ---------- painel ----------

async function admin(req, env, path, m, url) {
  const u = await auth(req, env);
  const isSuper = u.role === 'superadmin';
  const isAdmin = isSuper || u.role === 'admin';
  const isLeader = u.role === 'lider_squad';
  const need = (ok) => ok || fail(403, 'Seu cargo não pode fazer isso.');
  const canSee = (mem) => isAdmin || (isLeader && !!u.squad && mem.squad === u.squad);
  const q = (k) => url.searchParams.get(k) || '';
  const r = `${m} ${path}`;
  const body = async () => req.json().catch(() => fail(400, 'JSON inválido.'));

  if (r === 'GET me') return json({ name: u.name, role: u.role, squad: u.squad || '', mustChange: !!u.mustChange });
  if (r === 'POST logout') { await env.KV.delete('sess:' + u.token); return json({ ok: true }); }
  if (r === 'POST password') {
    need(!isSuper); // a senha do superadmin só muda nos secrets
    const b = await body();
    if (!(await safeEq(await hashPw(String(b.atual ?? ''), u.salt), u.hash))) fail(400, 'Senha atual incorreta.');
    const nova = String(b.nova ?? '');
    if (nova.length < 8 || nova.length > 128) fail(400, 'A nova senha precisa ter de 8 a 128 caracteres.');
    if (nova === b.atual) fail(400, 'A nova senha precisa ser diferente da atual.');
    u.salt = randHex(16);
    u.hash = await hashPw(nova, u.salt);
    u.mustChange = false;
    u.ver++;
    await putUser(env, u);
    await env.KV.delete('sess:' + u.token);
    return json(await newSession(env, u));
  }
  if (u.mustChange) fail(403, 'Troque sua senha provisória antes de continuar.');

  switch (r) {
    // ---- membros ----
    case 'GET members': {
      const all = await listVals(env, 'member:');
      if (isAdmin) return json(all);
      // líder também vê a ficha de quem pediu pro squad dele, sem as avaliações de outros
      const pedidos = new Set((await listVals(env, 'apply:'))
        .filter((a) => a.status === 'pendente' && a.squad === u.squad).map((a) => a.nick.toLowerCase()));
      return json(all.filter((x) => canSee(x) || pedidos.has(x.nick.toLowerCase()))
        .map((x) => (canSee(x) ? x : { ...x, candidato: true, nota: null, anotacoes: '', tags: [] })));
    }
    case 'GET tags':
      return json((await getJ(env, 'tags')) || DEFAULT_TAGS);
    case 'POST member': {
      const b = await body();
      const mem = isId(b.id) && (await getJ(env, 'member:' + b.id));
      if (!mem || !canSee(mem)) fail(404, 'Membro não encontrado.');
      if (b.nota !== undefined) {
        const n = b.nota === null || b.nota === '' ? null : +b.nota;
        if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 10)) fail(400, 'A nota vai de 1 a 10.');
        mem.nota = n;
      }
      if (b.anotacoes !== undefined) mem.anotacoes = clip(b.anotacoes, 3000);
      if (Array.isArray(b.tags)) {
        mem.tags = [...new Set(b.tags.map((t) => clip(t, 30).toLowerCase()).filter(Boolean))].slice(0, 20);
        await addTags(env, mem.tags);
      }
      let squadMudou = false;
      if (b.vaga !== undefined && b.vaga !== mem.vaga) {
        if (!['fixo', 'reserva'].includes(b.vaga)) fail(400, 'Vaga inválida.');
        mem.vaga = b.vaga; // líder pode: é do próprio squad (canSee)
        squadMudou = true;
      }
      const oldSquad = mem.squad;
      if (isAdmin) {
        if (b.status !== undefined && b.status !== mem.status) {
          if (!STATUS.includes(b.status)) fail(400, 'Status inválido.');
          mem.status = b.status;
          squadMudou = true; // "removido" sai da lista pública de fixos
        }
        if (b.squad !== undefined && b.squad !== mem.squad) {
          if (b.squad && !(isId(b.squad) && (await env.KV.get('squad:' + b.squad)))) fail(400, 'Squad não existe.');
          mem.squad = b.squad;
          mem.vaga = 'fixo'; // mudou de squad: começa como fixo
          squadMudou = true;
        }
      }
      await putJ(env, 'member:' + mem.id, mem);
      if (squadMudou) {
        const members = (await listVals(env, 'member:')).map((x) => (x.id === mem.id ? mem : x));
        await syncSquads(env, [oldSquad, mem.squad], members);
      }
      await log(env, u, `editou a ficha de ${mem.nick}`);
      return json(mem);
    }

    // ---- presença ----
    case 'GET attendance': {
      const all = await listVals(env, 'att:');
      if (isAdmin) return json(all);
      const mine = new Set((await listVals(env, 'member:')).filter(canSee).map((x) => x.id));
      return json(all.map((a) => ({ date: a.date, marks: Object.fromEntries(Object.entries(a.marks).filter(([id]) => mine.has(id))) })));
    }
    case 'POST attendance': {
      const b = await body();
      if (!isDate(b.date)) fail(400, 'Data inválida.');
      // shortcut: uma chave por data; dois admins salvando a mesma data no mesmo minuto podem se sobrescrever.
      const rec = (await getJ(env, 'att:' + b.date)) || { date: b.date, marks: {} };
      const members = Object.fromEntries((await listVals(env, 'member:')).filter(canSee).map((x) => [x.id, x]));
      const lines = [];
      for (const [id, mk] of Object.entries(b.marks || {})) {
        if (!members[id]) continue; // líder só marca o próprio squad
        // ocorrências: texto livre ligado a uma das 3 guerras do dia (g '' = o dia todo)
        const obs = (Array.isArray(mk?.o) ? mk.o : []).slice(0, 10)
          .map((o) => ({ g: ['1', '2', '3'].includes(o?.g) ? o.g : '', t: clip(o?.t, 200) })).filter((o) => o.t);
        if (!mk?.s && !obs.length) { delete rec.marks[id]; continue; }
        if (mk.s && !ATT[mk.s]) fail(400, 'Marcação inválida.');
        const next = { s: mk.s || '', j: mk.s === 'justificou' ? clip(mk.j, 300) : '', o: obs };
        const prev = rec.marks[id];
        const nick = members[id].nick;
        if (next.s && (prev?.s !== next.s || prev?.j !== next.j)) lines.push(`${ATT[next.s]} em ${nick}`);
        const antes = new Set((prev?.o || []).map((o) => o.g + '|' + o.t));
        for (const o of obs) if (!antes.has(o.g + '|' + o.t)) lines.push(`ocorrência em ${nick}${o.g ? ` (${o.g}ª guerra)` : ''}: "${o.t}"`);
        rec.marks[id] = next;
      }
      await putJ(env, 'att:' + b.date, rec);
      if (lines.length) await log(env, u, `marcou ${lines.join(', ')} em ${brDate(b.date)}`);
      return json({ ok: true }); // não devolve rec: o líder veria marcas de outros squads
    }
    case 'GET rsvp': {
      if (!isDate(q('date'))) fail(400, 'Data inválida.');
      return json(await listVals(env, `rsvp:${q('date')}:`));
    }

    // ---- squads e applies ----
    case 'GET squads': {
      const all = await listVals(env, 'squad:');
      return json(isAdmin ? all : all.filter((s) => s.id === u.squad));
    }
    case 'POST squad': {
      need(isAdmin);
      const b = await body();
      const sq = b.id ? await getJ(env, 'squad:' + b.id) : { id: uuid(), fixos: [] };
      if (!sq) fail(404, 'Squad não encontrado.');
      sq.nome = clip(b.nome, 40) || fail(400, 'Dê um nome ao squad.');
      sq.estilo = clip(b.estilo, 100);
      sq.funcoes = Array.isArray(b.funcoes) ? [...new Set(b.funcoes.map((f) => clip(f, 40)).filter(Boolean))].slice(0, 10) : sq.funcoes || [];
      sq.lider = clip(b.lider, 40);
      await putJ(env, 'squad:' + sq.id, sq);
      if (Array.isArray(b.fixos)) {
        const want = new Set(b.fixos);
        const members = await listVals(env, 'member:');
        const touched = [sq.id];
        for (const mem of members) {
          if ((mem.squad === sq.id) === want.has(mem.id)) continue;
          if (want.has(mem.id)) touched.push(mem.squad);
          mem.squad = want.has(mem.id) ? sq.id : '';
          mem.vaga = 'fixo';
          await putJ(env, 'member:' + mem.id, mem);
        }
        await syncSquads(env, touched, members);
      }
      await log(env, u, `${b.id ? 'editou' : 'criou'} o squad ${sq.nome}`);
      return json(await getJ(env, 'squad:' + sq.id));
    }
    case 'DELETE squad': {
      need(isAdmin);
      const sq = isId(q('id')) && (await getJ(env, 'squad:' + q('id')));
      if (!sq) fail(404, 'Squad não encontrado.');
      for (const mem of await listVals(env, 'member:')) {
        if (mem.squad === sq.id) { mem.squad = ''; await putJ(env, 'member:' + mem.id, mem); }
      }
      await env.KV.delete('squad:' + sq.id);
      await log(env, u, `apagou o squad ${sq.nome}`);
      return json({ ok: true });
    }
    case 'GET applies':
      return json((await listVals(env, 'apply:')).filter((a) => isAdmin || (isLeader && a.squad === u.squad)));
    case 'POST apply': {
      const b = await body();
      const a = isId(b.id) && (await getJ(env, 'apply:' + b.id));
      if (!a) fail(404, 'Apply não encontrado.');
      need(isAdmin || (isLeader && a.squad === u.squad));
      if (a.status !== 'pendente') fail(400, 'Esse apply já foi respondido.');
      if (b.aceitar) {
        const mid = await getJ(env, 'nick:' + a.nick.toLowerCase());
        const mem = mid && (await getJ(env, 'member:' + mid));
        if (!mem) fail(400, `O nick ${a.nick} ainda não fez o registro. Peça pra ele se registrar primeiro.`);
        const old = mem.squad;
        mem.squad = a.squad;
        mem.vaga = 'fixo';
        await putJ(env, 'member:' + mem.id, mem);
        const members = (await listVals(env, 'member:')).map((x) => (x.id === mem.id ? mem : x));
        await syncSquads(env, [old, a.squad], members);
      }
      a.status = b.aceitar ? 'aceito' : 'recusado';
      a.por = u.name;
      await putJ(env, 'apply:' + a.id, a);
      await log(env, u, `${b.aceitar ? 'aceitou' : 'recusou'} o apply de ${a.nick}`);
      return json(a);
    }

    // ---- táticas ----
    case 'GET posts':
      need(isAdmin);
      return json((await listVals(env, 'post:')).sort((a, b) => b.data.localeCompare(a.data)));
    case 'POST upload': {
      need(isAdmin);
      const fd = await req.formData().catch(() => fail(400, 'Formulário inválido.'));
      return json(await saveImages(env, await readImages(fd, 10)));
    }
    case 'POST post': {
      need(isAdmin);
      const b = await body();
      const old = b.id ? await getJ(env, 'post:' + b.id) : null;
      if (b.id && !old) fail(404, 'Post não encontrado.');
      const imgs = Array.isArray(b.imgs) ? b.imgs.filter(isId).slice(0, 30) : [];
      const post = {
        id: old?.id || uuid(),
        titulo: clip(b.titulo, 120) || fail(400, 'Dê um título ao post.'),
        texto: clip(b.texto, 20000),
        imgs,
        publico: !!b.publico,
        tipo: TIPOS_POST.includes(b.tipo) ? b.tipo : old?.tipo || 'tatica',
        data: old?.data || new Date().toISOString(),
        autor: old?.autor || u.name,
      };
      await putJ(env, 'post:' + post.id, post);
      await Promise.all((old?.imgs || []).filter((i) => !imgs.includes(i)).map((i) => env.KV.delete('img:' + i)));
      await log(env, u, `${old ? 'editou' : 'criou'} ${post.tipo === 'aviso' ? 'o aviso' : 'a tática'} "${post.titulo}"`);
      return json(post);
    }
    case 'DELETE post': {
      need(isAdmin);
      const post = isId(q('id')) && (await getJ(env, 'post:' + q('id')));
      if (!post) fail(404, 'Post não encontrado.');
      await Promise.all([env.KV.delete('post:' + post.id), ...post.imgs.map((i) => env.KV.delete('img:' + i))]);
      await log(env, u, `apagou ${post.tipo === 'aviso' ? 'o aviso' : 'a tática'} "${post.titulo}"`);
      return json({ ok: true });
    }

    // ---- equipe (só superadmin) ----
    case 'GET users':
      need(isSuper);
      return json((await listVals(env, 'user:')).map(({ hash, salt, ...x }) => x));
    case 'POST user': {
      need(isSuper);
      const b = await body();
      const name = clip(b.name, 32).toLowerCase();
      if (!/^[a-z0-9_.-]{2,32}$/.test(name)) fail(400, 'Usuário: 2 a 32 letras minúsculas, números, ponto, _ ou -.');
      if (name === superName(env)) fail(400, 'Esse nome é do superadmin.');
      let target = await getJ(env, 'user:' + name);
      if (b.novo && target) fail(409, 'Esse usuário já existe.');
      if (!b.novo && !target) fail(404, 'Usuário não encontrado.');
      target ||= { name, ver: 0 };
      const role = b.role ?? target.role;
      const squad = role === 'lider_squad' ? clip(b.squad ?? target.squad, 36) : '';
      if (!ROLES.includes(role)) fail(400, 'Cargo inválido.');
      if (role === 'lider_squad' && !(isId(squad) && (await env.KV.get('squad:' + squad)))) fail(400, 'Escolha o squad do líder.');
      const changes = [];
      if (role !== target.role || squad !== (target.squad || '')) { changes.push(`cargo ${role}`); target.ver++; }
      target.role = role;
      target.squad = squad;
      if (b.senha !== undefined || b.novo) {
        const senha = String(b.senha ?? '');
        if (senha.length < 8 || senha.length > 128) fail(400, 'A senha provisória precisa ter de 8 a 128 caracteres.');
        target.salt = randHex(16);
        target.hash = await hashPw(senha, target.salt);
        target.mustChange = true;
        target.ver++;
        changes.push(b.novo ? 'senha provisória' : 'senha resetada');
      }
      await putUser(env, target);
      await log(env, u, `${b.novo ? 'criou' : 'alterou'} o usuário ${name}: ${changes.join(', ')}`);
      return json({ ok: true });
    }
    case 'DELETE user': {
      need(isSuper);
      const name = q('name').toLowerCase();
      if (!(await env.KV.get('user:' + name))) fail(404, 'Usuário não encontrado.');
      await env.KV.delete('user:' + name);
      await log(env, u, `removeu o usuário ${name}`);
      return json({ ok: true });
    }
    // ---- webhook do Discord (admin e superadmin); o link inteiro nunca volta pro navegador ----
    case 'GET webhook': {
      need(isAdmin);
      const url = await webhookUrl(env);
      return json({ configurado: !!url, final: url.slice(-4) });
    }
    case 'POST webhook': {
      need(isAdmin);
      const url = clip((await body()).url, 300);
      if (url && !WEBHOOK_RE.test(url)) fail(400, 'Esse não parece um link de webhook do Discord. Ele começa com https://discord.com/api/webhooks/');
      await (url ? env.KV.put('webhook', url) : env.KV.delete('webhook'));
      await log(env, u, url ? 'salvou o webhook do Discord' : 'removeu o webhook do Discord');
      return json({ ok: true });
    }
    case 'POST webhook-teste': {
      need(isAdmin);
      if (!(await webhookUrl(env))) fail(400, 'Nenhum webhook salvo ainda.');
      if (!(await discord(env, 'Teste do site do clã', [['Enviado por', u.name]], []))) fail(502, 'O Discord recusou. Confira se o link está certo e se o webhook não foi apagado.');
      return json({ ok: true });
    }
    case 'GET log':
      need(isSuper);
      return json(await listVals(env, 'log:', 300));

    // ---- config (só superadmin) ----
    case 'POST config': {
      need(isSuper);
      const b = await body();
      const playstyles = (Array.isArray(b.playstyles) ? b.playstyles : [])
        .map((p) => ({ nome: clip(p?.nome, 40), desc: clip(p?.desc, 200) })).filter((p) => p.nome).slice(0, 20);
      const cfg = { horario: clip(b.horario, 200), regras: clip(b.regras, 20000), playstyles };
      await putJ(env, 'config', cfg);
      await log(env, u, 'alterou a config');
      return json(cfg);
    }

    // ---- backup (sem usuários, sessões e imagens) ----
    case 'GET backup': {
      need(isAdmin);
      const out = {};
      for (const prefix of BACKUP_PREFIXES) {
        let cursor;
        do {
          const res = await env.KV.list({ prefix, cursor });
          for (const k of res.keys) out[k.name] = await getJ(env, k.name);
          cursor = res.list_complete ? null : res.cursor;
        } while (cursor);
      }
      return json(out);
    }
    case 'POST backup': {
      need(isAdmin);
      const b = await body();
      const entries = Object.entries(b || {});
      if (entries.some(([k]) => !BACKUP_PREFIXES.some((p) => k === p || (p.endsWith(':') && k.startsWith(p))))) fail(400, 'O backup tem chaves desconhecidas.');
      // shortcut: o plano grátis do KV permite 1000 gravações por dia; backups maiores precisam ser importados aos poucos.
      for (const [k, v] of entries) await putJ(env, k, v);
      await log(env, u, `importou um backup com ${entries.length} itens`);
      return json({ ok: true, itens: entries.length });
    }
  }
  fail(404, 'Rota não encontrada.');
}
