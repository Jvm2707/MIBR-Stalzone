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
// Limites de imagem. O navegador já comprime, mas a barreira de verdade é aqui (o navegador pode ser burlado).
const IMG_MAX_BYTES = 1e6; // cada imagem
const ENVIO_MAX_BYTES = 5e6; // soma das imagens de um envio
const IMG_MAX_LADO = 4096; // pixels, em qualquer lado
const IMGS_POR_ENVIO = 4; // registro, gear, placar
const IMGS_POR_POST = 8; // táticas e avisos
const GEAR_PRINT_TTL = 60 * 86400; // prints de gear de atualizações antigas somem em 60 dias
const POSTADO_TTL = 400 * 86400; // memória do "já postado no Discord" (anti-repost)
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
  gearTipos: ['Speed', 'Tank', 'Híbrido'],
  modos: { qui: 'Torneio', sex: 'Torneio', sab: 'Torneio', dom: 'Base Capture' }, // modo de guerra por dia da semana
  seasons: [], // [{ id, nome, inicio: 'AAAA-MM-DD', fim: 'AAAA-MM-DD' }]
  seasonAtual: '',
  inativoFaltas: 3, // faltas seguidas pra virar inativo
  inativoDias: 14, // dias sem presença pra virar inativo
  // o que o Worker posta sozinho no Discord (os 3 primeiros já existiam, ficam ligados)
  discord: { registro: true, gear: true, apply: true, kdGame: false, kdDia: false, presenca: false, tatica: false },
};
const TIPOS_POST = ['tatica', 'aviso'];
// Season de uma data: a que cobre o dia; senão a marcada como atual (registros antigos são deduzidos pela data).
const seasonDe = (cfg, date) => cfg.seasons.find((s) => s.inicio <= date && date <= s.fim)?.id || cfg.seasonAtual || '';
const hoje = () => new Date().toISOString().slice(0, 10);
const int = (v, max) => Math.max(0, Math.min(max, Math.round(+v) || 0));
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
    const uso = contarUso(env);
    if (req.method === 'OPTIONS') res = new Response(null, { status: 204 });
    else {
      try {
        res = await route(req, uso.env, ctx);
      } catch (e) {
        if (e instanceof HttpError) res = json({ error: e.message }, e.status);
        else { console.error(e); res = json({ error: 'Erro interno. Tente de novo.' }, 500); }
      }
    }
    ctx.waitUntil(uso.salvar().catch((e) => console.error('uso', e)));
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    res.headers.set('X-Content-Type-Options', 'nosniff');
    return res;
  },
  // Cron (wrangler.toml): backup semanal pro Discord. Sem o secret, não faz nada.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(enviarBackup(env).catch((e) => console.error('backup', e)));
  },
};

// Conta gravações e remoções no KV (o grátis permite 1000/dia). Custa 1 gravação a mais por pedido que gravou algo.
function contarUso(env) {
  let n = 0;
  const KV = {
    get: (...a) => env.KV.get(...a), getWithMetadata: (...a) => env.KV.getWithMetadata(...a), list: (...a) => env.KV.list(...a),
    put: (...a) => { n++; return env.KV.put(...a); }, delete: (...a) => { n++; return env.KV.delete(...a); },
  };
  return {
    env: { ...env, KV },
    async salvar() {
      if (!n) return;
      const k = 'uso:' + hoje();
      await env.KV.put(k, String(+((await env.KV.get(k)) || 0) + n + 1), { expirationTtl: 2 * 86400 });
    },
  };
}

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  if (m === 'GET' && p === '/api/config') return json(await getConfig(env));
  if (m === 'GET' && p === '/api/squads') {
    const squads = await listVals(env, 'squad:');
    return json(squads.map((s) => ({
      id: s.id, nome: s.nome, estilo: s.estilo, lider: s.lider, funcoes: s.funcoes || [], builds: s.builds || [],
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
  const c = await getJ(env, 'config');
  return { ...DEFAULT_CONFIG, ...c, discord: { ...DEFAULT_CONFIG.discord, ...c?.discord } };
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

// Largura e altura lidas do cabeçalho do arquivo (sem decodificar a imagem). null = cabeçalho ilegível.
function dimensoes(b, type) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (type === 'image/png') return [dv.getUint32(16), dv.getUint32(20)];
    if (type === 'image/webp') {
      const tag = String.fromCharCode(...b.slice(12, 16));
      if (tag === 'VP8X') return [1 + (dv.getUint32(24, true) & 0xffffff), 1 + (dv.getUint32(27, true) & 0xffffff)];
      if (tag === 'VP8L') { const v = dv.getUint32(21, true); return [1 + (v & 0x3fff), 1 + ((v >>> 14) & 0x3fff)]; }
      if (tag === 'VP8 ') return [dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff];
    }
    if (type === 'image/jpeg') {
      // anda pelos marcadores até o SOF, que guarda altura e largura
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return [dv.getUint16(i + 7), dv.getUint16(i + 5)];
        if (mk === 0xff || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd8)) { i += mk === 0xff ? 1 : 2; continue; }
        i += 2 + dv.getUint16(i + 2);
      }
    }
  } catch { /* arquivo cortado */ }
  return null;
}

async function readImages(fd, max) {
  const files = fd.getAll('prints').filter((f) => typeof f !== 'string' && f.size);
  if (files.length > max) fail(400, `Máximo de ${max} imagens.`);
  if (files.reduce((s, f) => s + f.size, 0) > ENVIO_MAX_BYTES) fail(413, `As imagens juntas passam de ${ENVIO_MAX_BYTES / 1e6} MB.`);
  const out = [];
  for (const f of files) {
    if (f.size > IMG_MAX_BYTES) fail(413, `Cada imagem pode ter no máximo ${IMG_MAX_BYTES / 1e6} MB.`);
    const buf = await f.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const type = sniff(bytes);
    if (!type) fail(400, 'Só imagens JPG, PNG ou WEBP.');
    const dim = dimensoes(bytes, type);
    if (!dim || !dim[0] || !dim[1]) fail(400, 'Não deu pra ler o tamanho de uma das imagens. Tente salvar a print de novo.');
    if (Math.max(...dim) > IMG_MAX_LADO) fail(413, `Imagem grande demais (${dim[0]}x${dim[1]}). O máximo é ${IMG_MAX_LADO}px de cada lado.`);
    out.push({ buf, type });
  }
  return out;
}

// Prints de gear das atualizações anteriores passam a sumir em 60 dias; as da última ficam sem prazo.
// O KV não muda o prazo sozinho, então a imagem é gravada de novo com o prazo.
async function expirarPrintsAntigas(env, m) {
  for (const g of m.gear) {
    if (!g.imgs.length || g.expira) continue;
    for (const id of g.imgs) {
      const { value, metadata } = await env.KV.getWithMetadata('img:' + id, 'arrayBuffer');
      if (value) await env.KV.put('img:' + id, value, { metadata, expirationTtl: GEAR_PRINT_TTL });
    }
    g.expira = new Date(Date.now() + GEAR_PRINT_TTL * 1000).toISOString();
  }
}

// ttl (segundos) é usado nas prints de placar, que somem sozinhas em 7 dias
const saveImages = (env, imgs, ttl) =>
  Promise.all(imgs.map(async (im) => {
    const id = uuid();
    await env.KV.put('img:' + id, im.buf, { metadata: { type: im.type }, ...(ttl && { expirationTtl: ttl }) });
    return id;
  }));

// Tipos de gear marcados no formulário, só os que existem na config.
function gearTipos(fd, cfg) {
  const tipos = list(fd, 'gearTipo', 'Tipo de gear', 10, 30);
  if (tipos.some((x) => !cfg.gearTipos.includes(x))) fail(400, 'Tipo de gear inválido.');
  return tipos;
}

// ---------- leitura do placar com Workers AI ----------
// Testado com prints reais do Stalzone (placar de vitória e TAB): o Llama 4 Scout acertou 99% das linhas
// (com o painel casando nick lido com 1 letra trocada); o Llama 3.2 Vision acertava só ~20%.
const AI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
// O pedido descreve as duas telas do jogo e o que ignorar.
const AI_PROMPT = `You are reading a screenshot of the scoreboard of the game Stalzone. It is one of two screens:
1) "Final leaderboard" (after a win): a table under the 3D characters with the columns: position, nick, K, D, A, Treasury, Score, Rank.
2) "Battle Report" (TAB): a table on the right side with the columns: position, nick, K, D, A, Treasury, Score, Rank. IGNORE the left panel (Points Advantage, Points Captured, Kills/Deaths/Help boxes).
Read EVERY row of the table, from top to bottom, one by one. Do not skip rows and do not invent rows.
For each row, return:
- "nick": the player name exactly as written, but WITHOUT the clan tag in square brackets (for example "[Made in Brazil] Jaguison" becomes "Jaguison").
- "kills": the number in the K column, "deaths": the number in the D column, "assists": the number in the A column.
Ignore the Treasury, Score and Rank columns (they are big numbers and words like Sergeant, Officer).
Example: the row "1  [Made in Brazil] PlayerX  26  12  7  34430  8834  Officer" becomes {"nick":"PlayerX","kills":26,"deaths":12,"assists":7}.
Reply with ONLY a JSON array, no other text, no markdown: [{"nick":"...","kills":0,"deaths":0,"assists":0}]`;
async function lerPlacar(env, buf, type) {
  // o modelo recebe a imagem como data URL (base64), montado em pedaços pra não estourar a pilha
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const out = await env.AI.run(AI_MODEL, {
    messages: [{ role: 'user', content: [{ type: 'text', text: AI_PROMPT }, { type: 'image_url', image_url: { url: `data:${type};base64,${btoa(bin)}` } }] }],
    max_tokens: 2048,
  });
  const raw = out?.response;
  const arr = Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '').match(/\[[\s\S]*\]/)?.[0] ?? 'null');
  if (!Array.isArray(arr)) throw new Error('a IA não devolveu uma lista');
  return arr.filter((r) => typeof r?.nick === 'string' && r.nick.trim()).slice(0, 40).map((r) => ({
    nick: clip(r.nick.replace(/^\s*\[[^\]]*\]\s*/, ''), 32), // tira a tag do clã se a IA deixar passar
    kills: int(r.kills, 999), deaths: int(r.deaths, 999), assists: int(r.assists, 999),
  }));
}

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
  if (+req.headers.get('content-length') > ENVIO_MAX_BYTES + 1e6) fail(413, 'Envio grande demais.'); // folga pros campos de texto
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
  const cfg = await getConfig(env);
  m.gearTipos = gearTipos(fd, cfg);
  const gearTxt = txt(fd, 'gear', 'Gear', 1000);
  const imgs = await readImages(fd, IMGS_POR_ENVIO);
  if (gearTxt || imgs.length || m.gearTipos.length) {
    m.gear.push({ data: m.criadoEm, season: seasonDe(cfg, hoje()), tipos: m.gearTipos, texto: gearTxt, imgs: await saveImages(env, imgs) });
  }

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
    ['Microfone', mic === 'sim' ? 'Sim' : 'Não'], ['Tipo de gear', m.gearTipos.join(', ')], ['Gear', gearTxt], ['Sobre', m.sobre],
  ], imgs, 'registro').catch((e) => console.error('discord', e)));
  return json({ ok: true });
}

async function gear(fd, env, ctx) {
  const nick = txt(fd, 'nick', 'Nick', 32, true);
  const cfg = await getConfig(env);
  const tipos = gearTipos(fd, cfg);
  const texto = txt(fd, 'gear', 'Gear', 1000);
  const imgs = await readImages(fd, IMGS_POR_ENVIO);
  if (!texto && !imgs.length && !tipos.length) fail(400, 'Escreva o gear ou mande pelo menos um print.');
  const id = await getJ(env, 'nick:' + nick.toLowerCase());
  const m = id && (await getJ(env, 'member:' + id));
  if (!m) fail(404, 'Nick não encontrado. Faça o registro primeiro.');
  if (imgs.length) await expirarPrintsAntigas(env, m);
  m.gear.push({ data: new Date().toISOString(), season: seasonDe(cfg, hoje()), tipos, texto, imgs: await saveImages(env, imgs) });
  if (tipos.length) m.gearTipos = tipos; // o tipo mais recente é o que vale na ficha e no filtro
  await putJ(env, 'member:' + m.id, m);
  ctx.waitUntil(discord(env, `Gear atualizado: ${m.nick}`, [['Tipo de gear', tipos.join(', ')], ['Gear', texto]], imgs, 'gear').catch((e) => console.error('discord', e)));
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
  ctx.waitUntil(discord(env, `Apply pro squad ${sq.nome}: ${a.nick}`, [['Mensagem', a.msg]], [], 'apply').catch((e) => console.error('discord', e)));
  return json({ ok: true });
}

// O link salvo pelo painel tem prioridade; o secret DISCORD_WEBHOOK fica como alternativa.
const webhookUrl = async (env) => (await env.KV.get('webhook')) || env.DISCORD_WEBHOOK || '';
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

// Resultados e presença podem ir pra um canal separado; sem esse secret, vão pro principal.
const resultsUrl = async (env) => env.DISCORD_RESULTS_WEBHOOK || (await webhookUrl(env));

// Divide em embeds de até 25 campos e ~5500 caracteres (o Discord aceita 25 campos e 6000 por embed).
function montarEmbeds(title, fields, descricao = '') {
  const limpos = fields.filter(([, v]) => v !== '' && v != null)
    .map(([name, v]) => ({ name: String(name).slice(0, 256), value: String(v).slice(0, 1024), inline: String(v).length < 40 }));
  const grupos = [];
  let atual = null;
  let tam = 0;
  for (const f of limpos) {
    const t = f.name.length + f.value.length;
    if (!atual || atual.length >= 25 || tam + t > 5500) { atual = []; grupos.push(atual); tam = title.length + descricao.length + 20; }
    atual.push(f);
    tam += t;
  }
  if (!grupos.length) grupos.push([]);
  return grupos.map((fs, i) => ({
    title: (grupos.length > 1 ? `${title} (${i + 1}/${grupos.length})` : title).slice(0, 256),
    ...(i === 0 && descricao && { description: descricao.slice(0, 2000) }),
    color: 0x009c3b, fields: fs, timestamp: new Date().toISOString(),
  }));
}

// Uma mensagem por embed (fica longe do limite de 6000 por mensagem). Prints vão só na primeira.
async function postar(url, embeds, imgs = []) {
  let ok = true;
  for (const [i, embed] of embeds.entries()) {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ allowed_mentions: { parse: [] }, embeds: [embed] })); // nunca pinga ninguém
    if (i === 0) imgs.forEach((im, n) => fd.append(`files[${n}]`, new Blob([im.buf], { type: im.type }), `print${n + 1}.${im.type.split('/')[1]}`));
    const r = await fetch(url, { method: 'POST', body: fd });
    if (!r.ok) { ok = false; console.error('discord', r.status, await r.text()); }
  }
  return ok;
}

// tipo = interruptor da config (registro, gear, apply); sem tipo = sempre (ex.: teste do webhook)
async function discord(env, title, fields, imgs, tipo) {
  if (tipo && !(await getConfig(env)).discord[tipo]) return;
  const url = await webhookUrl(env);
  if (!url) return;
  return postar(url, montarEmbeds(title, fields), imgs);
}

// ---------- relatórios pro Discord ----------
const kdaTxt = (s) => `Kill (${s.k}) / Death (${s.d}) / Assist (${s.a}) / Rating (${((s.k + s.a) / Math.max(s.d, 1)).toFixed(2)})`;
// soma por jogador: [{ nick, k, d, a, jogos }], na ordem do painel (maior média de kills por game; empate: maior Rating)
function somarJogadores(results) {
  const por = {};
  for (const r of results) for (const l of r.linhas) {
    const s = (por[l.memberId] ||= { nick: l.nick, k: 0, d: 0, a: 0, jogos: 0 });
    s.k += l.kills; s.d += l.deaths; s.a += l.assists; s.jogos++;
  }
  const rt = (s) => (s.k + s.a) / Math.max(s.d, 1);
  return Object.values(por).sort((x, y) => y.k / y.jogos - x.k / x.jogos || rt(y) - rt(x));
}
const nomeSeasonW = (cfg, id) => cfg.seasons.find((s) => s.id === id)?.nome || 'sem season';
const daSeasonAtual = (cfg, x) => (x.season || seasonDe(cfg, x.date)) === cfg.seasonAtual;
// lista de nomes dividida em campos de até 1000 caracteres
function camposLista(titulo, nomes) {
  if (!nomes.length) return [[titulo, '-']];
  const out = [];
  let atual = '';
  for (const n of nomes) {
    if ((atual + ', ' + n).length > 1000) { out.push(atual); atual = n; } else atual = atual ? `${atual}, ${n}` : n;
  }
  out.push(atual);
  return out.map((v, i) => [i ? `${titulo} (cont.)` : titulo, v]);
}
// inativo = X faltas seguidas ou Y dias sem presença (o painel calcula igual)
function ehInativo(m, att, cfg) {
  if (!['teste', 'membro', 'veterano'].includes(m.status)) return false;
  const marcadas = att.filter((a) => a.marks[m.id]?.s).sort((a, b) => b.date.localeCompare(a.date));
  let seguidas = 0;
  for (const a of marcadas) { if (a.marks[m.id].s === 'faltou') seguidas++; else break; }
  const ultima = marcadas.find((a) => a.marks[m.id].s === 'presente')?.date || m.criadoEm.slice(0, 10);
  return seguidas >= cfg.inativoFaltas || (Date.parse(hoje()) - Date.parse(ultima)) / 864e5 >= cfg.inativoDias;
}

const REL = {
  kdGame: (r) => ({
    title: `KD do game ${r.game} de ${brDate(r.date)}${r.modo ? ` (${r.modo})` : ''}`,
    fields: somarJogadores([r]).map((s) => [s.nick, kdaTxt(s)]),
  }),
  kdDia: (date, results) => {
    const doDia = results.filter((r) => r.date === date);
    if (!doDia.length) fail(404, 'Nenhum game salvo nesse dia.');
    const js = somarJogadores(doDia);
    return {
      title: `KD do dia ${brDate(date)} (${doDia.length} ${doDia.length === 1 ? 'game' : 'games'})`,
      descricao: `Top 3: ${js.slice(0, 3).map((s, i) => `${i + 1}. ${s.nick}`).join(', ')}`,
      fields: js.map((s) => [s.nick, kdaTxt(s)]),
    };
  },
  presenca: (date, rec, nicks) => {
    const quem = (st) => Object.entries(rec.marks).filter(([id, mk]) => mk.s === st && nicks[id]).map(([id]) => nicks[id]).sort();
    // a justificativa é privada: só os nomes vão pro Discord
    return {
      title: `Presença de ${brDate(date)}`,
      fields: [...camposLista(`Presentes (${quem('presente').length})`, quem('presente')),
        ...camposLista(`Faltaram (${quem('faltou').length})`, quem('faltou')),
        ...camposLista(`Justificaram (${quem('justificou').length})`, quem('justificou'))],
    };
  },
  ranking: (cfg, results, modo) => ({
    title: `Ranking de KDA: ${nomeSeasonW(cfg, cfg.seasonAtual)}${modo ? ` (${modo})` : ''}`,
    fields: somarJogadores(results.filter((r) => daSeasonAtual(cfg, r) && (!modo || r.modo === modo))).slice(0, 10)
      .map((s, i) => [`${i + 1}. ${s.nick}`, `${kdaTxt(s)} em ${s.jogos} ${s.jogos === 1 ? 'game' : 'games'}`]),
  }),
  frequencia: (cfg, att, members, comInativos) => {
    const daSeason = att.filter((a) => daSeasonAtual(cfg, a));
    const ativos = members.filter((m) => ['teste', 'membro', 'veterano'].includes(m.status));
    const freq = ativos.map((m) => {
      const ms = daSeason.map((a) => a.marks[m.id]?.s).filter(Boolean);
      return { nick: m.nick, p: ms.filter((s) => s === 'presente').length, t: ms.length };
    }).filter((x) => x.t).sort((a, b) => b.p / b.t - a.p / a.t || b.p - a.p).slice(0, 10);
    return {
      title: `Frequência: ${nomeSeasonW(cfg, cfg.seasonAtual)}`,
      fields: [...freq.map((x, i) => [`${i + 1}. ${x.nick}`, `${Math.round((100 * x.p) / x.t)}% (${x.p}/${x.t})`]),
        ...(comInativos ? camposLista('Inativos', ativos.filter((m) => ehInativo(m, att, cfg)).map((m) => m.nick).sort()) : [])],
    };
  },
  semana: (results) => {
    const desde = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const rs = results.filter((r) => r.date >= desde && r.date <= hoje());
    const js = somarJogadores(rs);
    const tot = js.reduce((t, s) => ({ k: t.k + s.k, d: t.d + s.d, a: t.a + s.a }), { k: 0, d: 0, a: 0 });
    return {
      title: `Resumo da semana (${brDate(desde)} a ${brDate(hoje())})`,
      fields: [['Games', String(rs.length)], ['KDA médio do clã', rs.length ? kdaTxt(tot) : '-'],
        ['Destaque da semana', js[0] ? `${js[0].nick}: ${kdaTxt(js[0])}` : '-']],
    };
  },
};

// Postagem automática: respeita o interruptor e não reposta o mesmo game/dia/post.
// Devolve 'postado' | 'ja' (já foi postado: o painel oferece "repostar") | 'desligado' | 'sem-webhook' | 'erro'.
async function autoPost(env, tipo, id, gerar) {
  try {
    const cfg = await getConfig(env);
    if (!cfg.discord[tipo]) return 'desligado';
    if (await env.KV.get(`postado:${tipo}:${id}`)) return 'ja';
    const url = await (tipo === 'tatica' ? webhookUrl(env) : resultsUrl(env));
    if (!url) return 'sem-webhook';
    const r = await gerar();
    if (!(await postar(url, montarEmbeds(r.title, r.fields, r.descricao)))) return 'erro';
    await env.KV.put(`postado:${tipo}:${id}`, '1', { expirationTtl: POSTADO_TTL });
    return 'postado';
  } catch (e) {
    console.error('autoPost', tipo, e);
    return 'erro';
  }
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

// Funções e builds (tipo de gear + quantidade opcional) que o squad procura.
function procura(sq, b) {
  if (Array.isArray(b.funcoes)) sq.funcoes = [...new Set(b.funcoes.map((f) => clip(f, 40)).filter(Boolean))].slice(0, 10);
  if (Array.isArray(b.builds)) {
    const vistos = new Set();
    sq.builds = b.builds.map((x) => ({ tipo: clip(x?.tipo, 30), qtd: x?.qtd ? int(x.qtd, 20) || null : null }))
      .filter((x) => x.tipo && !vistos.has(x.tipo) && vistos.add(x.tipo)).slice(0, 10);
  }
  sq.funcoes ||= [];
  sq.builds ||= [];
}

async function backupDados(env) {
  const out = {};
  for (const prefix of BACKUP_PREFIXES) {
    let cursor;
    do {
      const res = await env.KV.list({ prefix, cursor });
      for (const k of res.keys) out[k.name] = await getJ(env, k.name);
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  }
  return out;
}

// Manda o mesmo JSON do backup manual como arquivo pro webhook privado. Sem o secret, não faz nada.
async function enviarBackup(env) {
  if (!env.DISCORD_BACKUP_WEBHOOK) return false;
  const dados = await backupDados(env);
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ content: `Backup do site do clã: ${Object.keys(dados).length} itens (sem imagens).`, allowed_mentions: { parse: [] } }));
  fd.append('files[0]', new Blob([JSON.stringify(dados)], { type: 'application/json' }), `backup-cla-${hoje()}.json`);
  const r = await fetch(env.DISCORD_BACKUP_WEBHOOK, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('Discord recusou o backup: ' + r.status);
  return true;
}

const BACKUP_PREFIXES = ['config', 'tags', 'member:', 'nick:', 'squad:', 'apply:', 'post:', 'att:', 'rsvp:', 'log:', 'res:'];

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
      // tirar do squad: admin ou o líder do próprio squad (canSee já garantiu que é do squad dele)
      if (b.tirarDoSquad && mem.squad) {
        mem.squad = '';
        mem.vaga = 'fixo';
        squadMudou = true;
      }
      if (isAdmin) {
        // dados do registro (só admin): vale o mesmo limite de tamanho do formulário público
        if (b.dados) {
          const d = b.dados;
          const sn = (v) => (v === 'sim' ? 'sim' : 'nao');
          const nick = clip(d.nick, 32);
          if (!nick) fail(400, 'O nick não pode ficar vazio.');
          if (nick.toLowerCase() !== mem.nick.toLowerCase()) {
            if (await env.KV.get('nick:' + nick.toLowerCase())) fail(409, 'Já existe um membro com esse nick.');
            await env.KV.delete('nick:' + mem.nick.toLowerCase());
            await putJ(env, 'nick:' + nick.toLowerCase(), mem.id);
            squadMudou = true; // o nick aparece na lista pública do squad
          }
          if (d.idade && !(/^\d+$/.test(d.idade) && +d.idade >= 10 && +d.idade <= 99)) fail(400, 'Idade precisa ser um número entre 10 e 99.');
          if (!/^GMT[+-]\d{1,2}(:\d{2})?$/.test(d.fuso)) fail(400, 'Fuso inválido.');
          const dias = Array.isArray(d.dias) ? d.dias.filter((x) => DIAS.includes(x)) : mem.dias;
          const arr = (v, n, len) => (Array.isArray(v) ? [...new Set(v.map((x) => clip(x, len)).filter(Boolean))].slice(0, n) : []);
          Object.assign(mem, {
            nick, discord: clip(d.discord, 40), idade: clip(d.idade, 3), pais: clip(d.pais, 60), fuso: d.fuso, dias,
            playstyles: arr(d.playstyles, 10, 40), playstyleOutro: clip(d.playstyleOutro, 100), gearTipos: arr(d.gearTipos, 10, 30),
            cla: sn(d.cla), claQual: clip(d.claQual, 200), fps: sn(d.fps), fpsQual: clip(d.fpsQual, 200), mic: sn(d.mic), sobre: clip(d.sobre, 1000),
          });
        }
        // um item do histórico de gear: editar texto/tipos ou apagar (com as prints)
        if (b.gearEdit) {
          const g = mem.gear[b.gearEdit.idx];
          if (!Number.isInteger(b.gearEdit.idx) || !g) fail(404, 'Item de gear não encontrado.');
          if (b.gearEdit.remover) {
            await Promise.all(g.imgs.map((i) => env.KV.delete('img:' + i)));
            mem.gear.splice(b.gearEdit.idx, 1);
          } else {
            g.texto = clip(b.gearEdit.texto, 1000);
            g.tipos = Array.isArray(b.gearEdit.tipos) ? [...new Set(b.gearEdit.tipos.map((x) => clip(x, 30)).filter(Boolean))].slice(0, 10) : g.tipos || [];
          }
        }
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
      if (b.tirarDoSquad) await log(env, u, `tirou ${mem.nick} do squad ${await getJ(env, 'squad:' + oldSquad).then((s) => s?.nome || '')}`);
      else await log(env, u, b.gearEdit ?`${b.gearEdit.remover ? 'apagou' : 'editou'} um gear de ${mem.nick}` : b.dados ? `editou o registro de ${mem.nick}` : `editou a ficha de ${mem.nick}`);
      return json(mem);
    }

    // Apagar membro (só admin): some o registro, o nick e as prints de gear.
    // Presença e resultados antigos ficam no histórico com o nick (o painel ignora quem não existe mais).
    case 'DELETE member': {
      need(isAdmin);
      const mem = isId(q('id')) && (await getJ(env, 'member:' + q('id')));
      if (!mem) fail(404, 'Membro não encontrado.');
      await Promise.all(mem.gear.flatMap((g) => g.imgs).map((i) => env.KV.delete('img:' + i)));
      await env.KV.delete('member:' + mem.id);
      if ((await getJ(env, 'nick:' + mem.nick.toLowerCase())) === mem.id) await env.KV.delete('nick:' + mem.nick.toLowerCase());
      if (mem.squad) await syncSquads(env, [mem.squad], (await listVals(env, 'member:')).filter((x) => x.id !== mem.id));
      await log(env, u, `apagou o membro ${mem.nick}`);
      return json({ ok: true });
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
      rec.season = seasonDe(await getConfig(env), b.date);
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
      const discPres = await autoPost(env, 'presenca', b.date, async () =>
        REL.presenca(b.date, rec, Object.fromEntries((await listVals(env, 'member:')).map((x) => [x.id, x.nick]))));
      return json({ ok: true, discord: { presenca: discPres } }); // não devolve rec: o líder veria marcas de outros squads
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
      procura(sq, b);
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
    // o que o squad procura: admin ou o líder do próprio squad
    case 'POST squad-procura': {
      const b = await body();
      const sq = isId(b.id) && (await getJ(env, 'squad:' + b.id));
      if (!sq) fail(404, 'Squad não encontrado.');
      need(isAdmin || (isLeader && sq.id === u.squad));
      procura(sq, b);
      await putJ(env, 'squad:' + sq.id, sq);
      await log(env, u, `editou o que o squad ${sq.nome} procura`);
      return json(sq);
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
      return json(await saveImages(env, await readImages(fd, IMGS_POR_POST)));
    }
    case 'POST post': {
      need(isAdmin);
      const b = await body();
      const old = b.id ? await getJ(env, 'post:' + b.id) : null;
      if (b.id && !old) fail(404, 'Post não encontrado.');
      const imgs = Array.isArray(b.imgs) ? b.imgs.filter(isId) : [];
      if (imgs.length > IMGS_POR_POST) fail(400, `Cada post pode ter no máximo ${IMGS_POR_POST} imagens.`);
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
      if (post.publico && post.tipo === 'tatica') {
        await autoPost(env, 'tatica', post.id, () => ({ title: `Nova tática: ${post.titulo}`, fields: [['Link', env.SITE_URL ? env.SITE_URL + '#taticas' : '']] }));
      }
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
    // ---- resultados / KDA: res:<data>:<game> ----
    // admin vê e edita tudo; líder só as linhas dos membros do próprio squad
    case 'POST upload-placar': {
      need(isAdmin || isLeader);
      const fd = await req.formData().catch(() => fail(400, 'Formulário inválido.'));
      return json(await saveImages(env, await readImages(fd, IMGS_POR_ENVIO), 7 * 86400)); // somem em 7 dias
    }
    case 'POST ler-placar': {
      need(isAdmin || isLeader);
      const ids = (await body()).ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 4 || !ids.every(isId)) fail(400, 'Mande de 1 a 4 prints.');
      if (!env.AI) fail(502, 'A leitura automática não está ativada no Worker. Preencha a tabela na mão.');
      const linhas = [];
      try {
        for (const id of ids) {
          const { value: buf, metadata } = await env.KV.getWithMetadata('img:' + id, 'arrayBuffer');
          if (!buf) fail(404, 'Uma das prints já expirou. Envie de novo.');
          linhas.push(...(await lerPlacar(env, buf, metadata?.type || 'image/jpeg')));
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error('ia', e);
        fail(502, 'Não deu pra ler as prints (limite grátis da IA ou print difícil de ler). Preencha a tabela na mão.');
      }
      // a mesma pessoa em duas prints conta uma vez
      const vistos = new Set();
      return json(linhas.filter((l) => !vistos.has(l.nick.toLowerCase()) && vistos.add(l.nick.toLowerCase())));
    }
    case 'GET results': {
      const all = await listVals(env, 'res:');
      if (isAdmin) return json(all);
      const mine = new Set((await listVals(env, 'member:')).filter(canSee).map((x) => x.id));
      return json(all.map((r) => ({ ...r, linhas: r.linhas.filter((l) => mine.has(l.memberId)) })));
    }
    case 'POST result': {
      need(isAdmin || isLeader);
      const b = await body();
      const game = +b.game;
      if (!isDate(b.date) || ![1, 2, 3].includes(game)) fail(400, 'Escolha a data e o game (1, 2 ou 3).');
      const key = `res:${b.date}:${game}`;
      const old = await getJ(env, key);
      const members = Object.fromEntries((await listVals(env, 'member:')).filter(canSee).map((x) => [x.id, x]));
      const vistos = new Set();
      const novas = (Array.isArray(b.linhas) ? b.linhas : []).slice(0, 60)
        .filter((l) => members[l?.memberId] && !vistos.has(l.memberId) && vistos.add(l.memberId))
        .map((l) => ({ memberId: l.memberId, nick: members[l.memberId].nick, kills: int(l.kills, 999), deaths: int(l.deaths, 999), assists: int(l.assists, 999) }));
      // líder não apaga nem mexe nas linhas de quem não é do squad dele
      const outras = (old?.linhas || []).filter((l) => !members[l.memberId]);
      const rec = {
        date: b.date, game, modo: clip(b.modo, 40) || old?.modo || '', season: seasonDe(await getConfig(env), b.date),
        linhas: [...outras, ...novas], prints: Array.isArray(b.prints) ? b.prints.filter(isId).slice(0, 4) : old?.prints || [],
        por: u.name, em: new Date().toISOString(),
      };
      await putJ(env, key, rec);
      const disc = { kdGame: await autoPost(env, 'kdGame', `${b.date}:${game}`, () => REL.kdGame(rec)) };
      // game 3 = último game do dia
      if (game === 3) disc.kdDia = await autoPost(env, 'kdDia', b.date, async () => REL.kdDia(b.date, await listVals(env, 'res:')));
      await log(env, u, `${old ? 'editou' : 'salvou'} o resultado de ${brDate(b.date)}, game ${game} (${rec.modo || 'sem modo'}): ${novas.length} ${novas.length === 1 ? "jogador" : "jogadores"}`);
      return json({ ...(isAdmin ? rec : { ...rec, linhas: novas }), discord: disc });
    }
    case 'DELETE result': {
      need(isAdmin);
      const key = `res:${q('date')}:${q('game')}`;
      if (!isDate(q('date')) || !(await env.KV.get(key))) fail(404, 'Resultado não encontrado.');
      await env.KV.delete(key);
      await log(env, u, `apagou o resultado de ${brDate(q('date'))}, game ${q('game')}`);
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
    case 'POST discord-config': {
      need(isAdmin);
      const b = await body();
      const cfg = await getConfig(env);
      for (const k of Object.keys(DEFAULT_CONFIG.discord)) if (typeof b.discord?.[k] === 'boolean') cfg.discord[k] = b.discord[k];
      await putJ(env, 'config', cfg);
      await log(env, u, 'mudou o que é postado no Discord');
      return json(cfg.discord);
    }
    // postagem manual com prévia: previa=true só devolve os embeds, sem enviar
    case 'POST discord-postar': {
      need(isAdmin);
      const b = await body();
      const cfg = await getConfig(env);
      const results = () => listVals(env, 'res:');
      let r;
      let marca = ''; // marca como postado pra não repostar sozinho depois
      let nome;
      if (b.tipo === 'kdDia') {
        if (!isDate(b.date)) fail(400, 'Escolha o dia.');
        r = REL.kdDia(b.date, await results()); marca = 'kdDia:' + b.date; nome = 'KD do dia ' + brDate(b.date);
      } else if (b.tipo === 'kdGame') {
        const rec = isDate(b.date) && (await getJ(env, `res:${b.date}:${+b.game}`));
        if (!rec) fail(404, 'Game não encontrado.');
        r = REL.kdGame(rec); marca = `kdGame:${b.date}:${+b.game}`; nome = `KD do game ${+b.game} de ${brDate(b.date)}`;
      } else if (b.tipo === 'presenca') {
        const rec = isDate(b.date) && (await getJ(env, 'att:' + b.date));
        if (!rec) fail(404, 'Nenhuma presença salva nesse dia.');
        r = REL.presenca(b.date, rec, Object.fromEntries((await listVals(env, 'member:')).map((x) => [x.id, x.nick])));
        marca = 'presenca:' + b.date; nome = 'presença de ' + brDate(b.date);
      } else if (b.tipo === 'ranking') {
        if (!cfg.seasonAtual) fail(400, 'Marque a season atual na Config primeiro.');
        r = REL.ranking(cfg, await results(), clip(b.modo, 40)); nome = 'ranking de KDA da season';
      } else if (b.tipo === 'frequencia') {
        if (!cfg.seasonAtual) fail(400, 'Marque a season atual na Config primeiro.');
        r = REL.frequencia(cfg, await listVals(env, 'att:'), await listVals(env, 'member:'), !!b.inativos); nome = 'frequência da season';
      } else if (b.tipo === 'semana') {
        r = REL.semana(await results()); nome = 'resumo da semana';
      } else fail(400, 'Tipo de postagem inválido.');
      const embeds = montarEmbeds(r.title, r.fields, r.descricao);
      if (b.previa) return json(embeds);
      const url = await resultsUrl(env);
      if (!url) fail(400, 'Nenhum webhook configurado. Salve o link na aba Discord.');
      if (!(await postar(url, embeds))) fail(502, 'O Discord recusou a postagem. Confira o webhook.');
      if (marca) await env.KV.put('postado:' + marca, '1', { expirationTtl: POSTADO_TTL });
      await log(env, u, `postou ${nome} no Discord`);
      return json({ ok: true, mensagens: embeds.length });
    }
    case 'GET log':
      need(isSuper);
      return json(await listVals(env, 'log:', 300));

    // ---- config (só superadmin) ----
    case 'POST config': {
      need(isSuper);
      const b = await body();
      // só muda o que veio no pedido; o resto da config fica como estava
      const cfg = await getConfig(env);
      if (b.horario !== undefined) cfg.horario = clip(b.horario, 200);
      if (b.regras !== undefined) cfg.regras = clip(b.regras, 20000);
      if (Array.isArray(b.playstyles)) {
        cfg.playstyles = b.playstyles.map((p) => ({ nome: clip(p?.nome, 40), desc: clip(p?.desc, 200) })).filter((p) => p.nome).slice(0, 20);
      }
      if (Array.isArray(b.gearTipos)) cfg.gearTipos = [...new Set(b.gearTipos.map((x) => clip(x, 30)).filter(Boolean))].slice(0, 10);
      if (b.modos && typeof b.modos === 'object') cfg.modos = Object.fromEntries(DIAS.map((d) => [d, clip(b.modos[d], 40)]).filter(([, v]) => v));
      if (Array.isArray(b.seasons)) {
        cfg.seasons = b.seasons.slice(0, 60).map((s) => {
          const nome = clip(s?.nome, 40);
          if (!nome || !isDate(s?.inicio) || !isDate(s?.fim) || s.inicio > s.fim) fail(400, 'Cada season precisa de nome, início e fim (o fim depois do início).');
          return { id: isId(s.id) ? s.id : uuid(), nome, inicio: s.inicio, fim: s.fim };
        }).sort((x, y) => x.inicio.localeCompare(y.inicio));
      }
      if (b.seasonAtual !== undefined) cfg.seasonAtual = cfg.seasons.some((s) => s.id === b.seasonAtual) ? b.seasonAtual : '';
      // season atual escolhida pelo nome quando ela acabou de ser criada (ainda sem id no navegador)
      if (b.inativoFaltas !== undefined) cfg.inativoFaltas = Math.max(1, int(b.inativoFaltas, 50));
      if (b.inativoDias !== undefined) cfg.inativoDias = Math.max(1, int(b.inativoDias, 365));
      if (b.seasonAtualNome) cfg.seasonAtual = cfg.seasons.find((s) => s.nome === b.seasonAtualNome)?.id || cfg.seasonAtual;
      await putJ(env, 'config', cfg);
      await log(env, u, 'alterou a config');
      return json(cfg);
    }

    // ---- backup (sem usuários, sessões e imagens) ----
    case 'GET backup':
      need(isAdmin);
      return json(await backupDados(env));
    case 'POST backup-teste': {
      need(isSuper);
      if (!env.DISCORD_BACKUP_WEBHOOK) fail(400, 'O secret DISCORD_BACKUP_WEBHOOK ainda não foi configurado no Worker.');
      try { await enviarBackup(env); } catch { fail(502, 'O Discord recusou o backup. Confira o link do webhook de backup.'); }
      await log(env, u, 'enviou um backup de teste pro Discord');
      return json({ ok: true });
    }
    case 'GET uso':
      need(isSuper);
      return json({ hoje: +((await env.KV.get('uso:' + hoje())) || 0), limite: 1000 });
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
