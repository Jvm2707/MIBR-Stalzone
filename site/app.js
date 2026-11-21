// Funções usadas pelo site e pelo painel, e a lógica das páginas públicas.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const imgUrl = (id) => `${CONFIG.API}/api/img/${encodeURIComponent(id)}`;

// ---------- idioma ----------
// O painel não carrega i18n.js, então lá tudo fica em português.
let lang = 'pt';
const LOCALE = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' };
function t(pt, vars = {}) {
  const s = (lang !== 'pt' && typeof I18N !== 'undefined' && I18N[pt]?.[lang === 'en' ? 0 : 1]) || pt;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
// Mensagens de erro do Worker (em português) traduzidas quando der.
function tErr(msg) {
  if (lang === 'pt' || typeof I18N_RE === 'undefined') return msg;
  for (const [re, en, es] of I18N_RE) {
    const m = msg.match(re);
    if (m) return (lang === 'en' ? en : es).replace(/\{(\d)\}/g, (_, i) => t(m[i]));
  }
  return t(msg);
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString(LOCALE[lang]);

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(CONFIG.API + path, { method, headers, body });
  } catch {
    throw new Error('Sem conexão com o servidor. Confira a internet e tente de novo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function say(el, msg, bad = false) {
  el.textContent = msg;
  el.classList.toggle('bad', bad);
}

// Limites do navegador (o Worker confere de novo: 1 MB e 4096px por imagem).
const IMG_ORIGINAL_MAX = 15e6; // acima disso nem tenta abrir
const IMG_ALVO = 8e5; // ~800 KB depois de comprimir
const IMG_LADO = 1920; // lado maior depois de redimensionar

// Redimensiona pra no máx. 1920px e comprime em webp (ou jpeg, se o navegador não fizer webp) até ~800 KB.
async function compress(file) {
  const bmp = await createImageBitmap(file);
  if (file.size <= IMG_ALVO && Math.max(bmp.width, bmp.height) <= IMG_LADO) return file; // já está bom: recomprimir só piora
  const canvas = document.createElement('canvas');
  let scale = Math.min(1, IMG_LADO / Math.max(bmp.width, bmp.height));
  let q = 0.85;
  let blob;
  for (let i = 0; i < 12; i++) {
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', q));
    if (blob?.type !== 'image/webp') blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q)); // Safari antigo
    if (blob.size <= IMG_ALVO) break;
    if (q > 0.6) q -= 0.1;
    else scale *= 0.8;
  }
  return blob;
}

// Campo de arquivos com pré-visualização. O <input> não tem name: os blobs comprimidos vão no envio.
// Ctrl+V com imagem copiada (print do jogo, recorte do Windows): vai pro campo de imagem visível.
// Se tiver mais de um na tela, vai pro do formulário em que a pessoa está.
const PICKERS = [];
document.addEventListener('paste', (e) => {
  const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return;
  const visiveis = PICKERS.filter((p) => p.input.isConnected && p.input.offsetParent);
  const alvo = visiveis.find((p) => p.input.form?.contains(document.activeElement)) || visiveis[0];
  if (!alvo) return;
  e.preventDefault();
  alvo.adicionar(imgs.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `print-colada-${i + 1}.${f.type.split('/')[1]}`, { type: f.type }))));
});

function imagePicker(input, previews, max, statusEl) {
  let files = [];
  const draw = () => {
    previews.replaceChildren(...files.map((f, i) => {
      const fig = document.createElement('figure');
      fig.innerHTML = `<img src="${f.url}" alt="${esc(t('Print {n}', { n: i + 1 }))}"><figcaption>${Math.round(f.blob.size / 1024)} KB</figcaption>
        <button type="button" aria-label="${esc(t('Remover print {n}', { n: i + 1 }))}">×</button>`;
      fig.querySelector('button').onclick = () => {
        URL.revokeObjectURL(f.url);
        files.splice(i, 1);
        draw();
        input.focus();
      };
      return fig;
    }));
  };
  // mesmo caminho pra arquivo escolhido no botão e pra print colada com Ctrl+V
  const adicionar = async (picked) => {
    for (const file of picked) {
      if (files.length >= max) { say(statusEl, t('Máximo de {n} imagens.', { n: max }), true); break; }
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { say(statusEl, t('"{nome}" não é JPG, PNG ou WEBP.', { nome: file.name }), true); continue; }
      if (file.size > IMG_ORIGINAL_MAX) { say(statusEl, t('"{nome}" tem mais de 15 MB. Escolha uma imagem menor.', { nome: file.name }), true); continue; }
      try {
        const blob = await compress(file);
        files.push({ blob, url: URL.createObjectURL(blob) });
      } catch {
        say(statusEl, t('Não deu pra ler "{nome}".', { nome: file.name }), true);
      }
    }
    draw();
  };
  input.addEventListener('change', () => { const picked = [...input.files]; input.value = ''; adicionar(picked); });
  input.insertAdjacentHTML('afterend', `<span class="hint">${esc(t('Dica: você também pode colar a print aqui com Ctrl+V.'))}</span>`);
  PICKERS.push({ input, adicionar });
  return {
    get: () => files.map((f) => f.blob),
    clear() { files.forEach((f) => URL.revokeObjectURL(f.url)); files = []; draw(); },
  };
}

// ---------- Turnstile ----------
let tsReady = false;
function ensureTS(el) {
  if (!tsReady || !el || el.dataset.w) return;
  el.dataset.w = turnstile.render(el, { sitekey: CONFIG.TURNSTILE_SITEKEY, theme: 'dark', language: { pt: 'pt-br', en: 'en', es: 'es' }[lang] });
}
function resetTS(el) {
  if (el?.dataset.w) turnstile.reset(el.dataset.w);
}

// ---------- páginas públicas ----------
if (document.getElementById('f-registro')) {
  // idioma: o escolhido antes, senão o do navegador
  try { lang = localStorage.getItem('lang') || ''; } catch { /* sem storage */ }
  if (!LOCALE[lang]) lang = { en: 'en', es: 'es' }[(navigator.language || '').slice(0, 2)] || 'pt';

  window.onTsLoad = () => {
    tsReady = true;
    document.querySelectorAll('.ts').forEach((el) => el.offsetParent && ensureTS(el));
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTsLoad';
  s.async = true;
  document.head.append(s);

  // Navegação por #hash: uma seção visível por vez.
  const sections = [...document.querySelectorAll('main > section')];
  const show = (focus) => {
    const id = location.hash.slice(1).split('/')[0]; // #perfil/<id>
    // sem acesso (ou sem página escolhida): a primeira que a pessoa pode ver. Registro pra quem ainda não se
    // registrou neste navegador, Meu registro pra quem já se registrou (o Worker também recusa o que não pode)
    const pode = (x) => !x.dataset.so || window.podeVer?.(x.dataset.so);
    let current = sections.find((x) => x.id === id);
    if (!current || !pode(current)) current = sections.find(pode) || sections[0];
    sections.forEach((x) => (x.hidden = x !== current));
    document.querySelectorAll('.top nav a').forEach((a) =>
      a.hash === '#' + current.id ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    current.querySelectorAll('.ts').forEach(ensureTS);
    window.aoMostrar?.(current.id);
    if (focus) current.querySelector('h1').focus();
  };
  addEventListener('hashchange', () => show(true));
  show(false);

  // Mostra "qual clã" e "qual FPS" só quando a resposta é sim.
  document.querySelectorAll('[data-toggle]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const id = inp.dataset.toggle;
      document.getElementById(id).hidden = document.querySelector(`[data-toggle="${id}"]:checked`)?.value !== 'sim';
    }));

  // done/check devolvem o texto em português; t() traduz na hora de mostrar
  function wire(form, url, { picker, check, done, depois }) {
    const st = form.querySelector('.status');
    const btn = form.querySelector('[type=submit]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = check?.();
      if (problem) return say(st, t(problem), true);
      const fd = new FormData(form);
      if (!fd.get('cf-turnstile-response')) return say(st, t('Marque o captcha antes de enviar.'), true);
      picker?.get().forEach((b, i) => fd.append('prints', b, `print${i + 1}.jpg`));
      btn.disabled = true;
      say(st, t('Enviando…'));
      try {
        const resp = await api(url, { method: 'POST', body: fd });
        form.reset();
        form.querySelectorAll('[data-toggle]').forEach((i) => (document.getElementById(i.dataset.toggle).hidden = true));
        picker?.clear();
        say(st, t(done));
        depois?.(resp);
      } catch (err) {
        say(st, tErr(err.message), true);
      } finally {
        btn.disabled = false;
        resetTS(form.querySelector('.ts'));
      }
    });
  }

  const fr = document.getElementById('f-registro');
  wire(fr, '/api/register', {
    picker: imagePicker(fr.querySelector('#r-prints'), fr.querySelector('.previews'), 4, fr.querySelector('.status')),
    check: () => (!fr.querySelector('[name=dias]:checked') ? 'Marque pelo menos um dia em que pode jogar.' : ''),
    depois: (resp) => window.entrou?.(resp.token), // já entra logado e vê "aguardando aprovação"
    done: 'Registro enviado! Fique de olho no Discord: um admin vai chamar você.',
  });
  const dlg = document.getElementById('d-apply');
  const fa = document.getElementById('f-apply');
  wire(fa, '/api/apply', { done: 'Apply enviado! O líder vai ver no painel.', depois: () => (fa.nick.value = window.meuNick?.() || '') }); // reset apaga o nick escondido
  dlg.querySelector('[data-close]').onclick = () => dlg.close();

  // ---- dados que chegam do Worker (guardados pra redesenhar ao trocar de idioma) ----
  const SEM_PREF = 'Não tenho preferência'; // valor fixo enviado ao Worker, em qualquer idioma
  const DEFAULT_ROLES = [ // aparece mesmo sem o Worker; a Config do painel substitui
    { nome: 'Livre', desc: 'Não fica preso a um lugar: roda o mapa e aparece onde o time mais precisa, seja fechando um buraco, cobrindo um aliado ou ajudando a virar uma luta.' },
    { nome: 'Suporte', desc: 'Acompanha um squad num ponto importante e deixa o trabalho dele mais fácil: joga granada, constrói defesas e segura a posição junto.' },
    { nome: 'Sniper', desc: 'Joga à distância: controla as linhas de visão, avisa onde o inimigo está e derruba quem tenta atravessar.' },
    { nome: 'Tank', desc: 'Escolhe um lugar e não sai dele: segura o ponto, aguenta a pressão e é o último a cair.' },
  ];
  const D = { cfg: null, cfgErr: '', squads: null, squadsErr: '', posts: {}, postsErr: {} };
  const rolesBox = document.getElementById('r-playstyles');
  const squadSel = document.getElementById('r-squad');
  const fusoSel = document.getElementById('r-fuso');

  // Fuso no formato GMT±h, já marcando o do aparelho.
  const gmt = (min) => `GMT${min < 0 ? '-' : '+'}${Math.floor(Math.abs(min) / 60)}${Math.abs(min) % 60 ? ':' + String(Math.abs(min) % 60).padStart(2, '0') : ''}`;
  const DICA = { '-300': 'Acre, Nova York no inverno', '-240': 'Manaus, Nova York no verão', '-180': 'Brasília, Buenos Aires', 0: 'Londres, Lisboa', 60: 'Paris, Madri' };
  const meu = -new Date().getTimezoneOffset();
  const fusos = [...new Set([...Array.from({ length: 27 }, (_, i) => (i - 12) * 60), meu])].sort((a, b) => a - b);
  function renderFuso() {
    const atual = fusoSel.value;
    fusoSel.innerHTML = `<option value="">${esc(t('Escolha'))}</option>` + fusos.map((m) =>
      `<option value="${gmt(m)}"${m === meu ? ' selected' : ''}>${gmt(m)}${DICA[m] ? ` (${esc(t(DICA[m]))})` : ''}</option>`).join('');
    if (atual) fusoSel.value = atual; // mantém a escolha ao trocar de idioma
  }

  // Tipos de gear (Speed/Tank/Híbrido...) nos formulários de registro e de gear; valor enviado sempre em português
  function renderGearTipos() {
    const tipos = D.cfg?.gearTipos?.length ? D.cfg.gearTipos : ['Speed', 'Tank', 'Híbrido'];
    document.querySelectorAll('[data-gear-tipos]').forEach((box) => {
      const marcados = new Set([...box.querySelectorAll('input:checked')].map((i) => i.value));
      box.innerHTML = tipos.map((g) => `<label class="check"><input type="checkbox" name="gearTipo" value="${esc(g)}"${marcados.has(g) ? ' checked' : ''}> ${esc(t(g))}</label>`).join('');
    });
  }

  function renderRoles() {
    const marcados = new Set([...rolesBox.querySelectorAll('input:checked')].map((i) => i.value));
    const lista = [...(D.cfg?.playstyles.length ? D.cfg.playstyles : DEFAULT_ROLES),
      { nome: SEM_PREF, desc: 'Topa qualquer função. O líder decide onde você encaixa melhor.' }];
    rolesBox.innerHTML = lista.map((p) => `<label class="role"><input type="checkbox" name="playstyle" value="${esc(p.nome)}"${marcados.has(p.nome) ? ' checked' : ''}>
      <span><strong>${esc(t(p.nome))}</strong>${p.desc ? `<span class="hint">${esc(t(p.desc))}</span>` : ''}</span></label>`).join('');
  }

  // Recomenda os squads que precisam de alguma das funções marcadas.
  function recommend() {
    const squads = D.squads || [];
    const chosen = [...rolesBox.querySelectorAll('input:checked')].map((i) => i.value).filter((v) => v !== SEM_PREF);
    const recs = squads.filter((s) => s.funcoes.some((f) => chosen.includes(f)));
    const atual = squadSel.value;
    squadSel.innerHTML = `<option value="">${esc(t('Sem preferência'))}</option>` + squads.map((s) =>
      `<option value="${esc(s.id)}">${esc(recs.includes(s) ? t('{nome} (recomendado pra você)', { nome: s.nome }) : s.nome)}</option>`).join('');
    squadSel.value = atual;
    document.getElementById('r-rec').textContent = recs.length
      ? t('Recomendado pra você: {lista}.', { lista: recs.map((s) => t('{nome} (precisa de {f})', { nome: s.nome, f: s.funcoes.filter((f) => chosen.includes(f)).map((f) => t(f)).join(', ') })).join('; ') })
      : chosen.length && squads.length ? t('Nenhum squad pediu essa função ainda. Pode escolher qualquer um.') : '';
  }
  rolesBox.addEventListener('change', (e) => {
    if (e.target.checked) {
      // marcar "sem preferência" desmarca o resto, e vice-versa
      rolesBox.querySelectorAll('input:checked').forEach((i) => {
        if (i !== e.target && (i.value === SEM_PREF || e.target.value === SEM_PREF)) i.checked = false;
      });
    }
    recommend();
  });
  fr.addEventListener('reset', () => setTimeout(recommend));

  function renderConfig() {
    const regras = document.getElementById('regras-texto');
    if (D.cfgErr) { regras.textContent = `${t('Não deu pra carregar as regras.')} ${tErr(D.cfgErr)}`; return; }
    if (!D.cfg) { regras.textContent = t('Carregando…'); return; }
    document.querySelectorAll('[data-horario]').forEach((el) => (el.textContent = t(D.cfg.horario)));
    regras.textContent = t(D.cfg.regras); // só traduz o texto padrão; regras escritas pelo admin ficam como estão
  }

  function renderSquads() {
    const list = document.getElementById('squads-list');
    if (D.squadsErr) { list.innerHTML = `<p class="status bad">${esc(t('Não deu pra carregar os squads.'))} ${esc(tErr(D.squadsErr))}</p>`; return; }
    if (!D.squads) { list.innerHTML = `<p class="muted">${esc(t('Carregando squads…'))}</p>`; return; }
    if (!D.squads.length) { list.innerHTML = `<p class="muted">${esc(t('Nenhum squad criado ainda.'))}</p>`; return; }
    // membro aprovado clica no nick e abre o perfil; visitante vê só o nome
    const nicks = (arr, ids = []) => (arr.length ? `<ul class="nicks">${arr.map((n, i) => `<li>${window.podeVer?.('membro') && ids[i] ? `<a href="#perfil/${esc(ids[i])}">${esc(n)}</a>` : esc(n)}</li>`).join('')}</ul>` : '');
    list.innerHTML = D.squads.map((sq) => {
      const res = sq.reservas || [];
      const builds = (sq.builds || []).map((b) => (b.qtd ? `${b.qtd} ${t(b.tipo)}` : t(b.tipo))).join(', ');
      // o que o squad procura vem no topo do card
      return `<article class="card">
        ${builds || sq.funcoes.length ? `<div class="procura">
          ${builds ? `<p>${esc(t('Procura builds: {lista}', { lista: builds }))}</p>` : ''}
          ${sq.funcoes.length ? `<p>${esc(t('Procura funções: {f}', { f: sq.funcoes.map((f) => t(f)).join(', ') }))}</p>` : ''}
        </div>` : ''}
        <h2>${esc(sq.nome)}</h2>
        ${sq.estilo ? `<p class="meta">${esc(sq.estilo)}</p>` : ''}
        <p class="meta">${esc(t('Líder: {nome}', { nome: sq.lider || t('a definir') }))}</p>
        <p><span class="count">${sq.fixos.length}</span> <span class="muted">${esc(t(sq.fixos.length === 1 ? 'fixo' : 'fixos'))}</span></p>
        ${nicks(sq.fixos, sq.fixosIds)}
        ${res.length ? `<p class="muted">${res.length} ${esc(t(res.length === 1 ? 'reserva' : 'reservas'))}</p>${nicks(res, sq.reservasIds)}` : ''}
        <div><button type="button" class="primary" data-apply="${esc(sq.id)}" data-nome="${esc(sq.nome)}">${esc(t('Dar apply'))}</button></div>
      </article>`;
    }).join('');
    list.querySelectorAll('[data-apply]').forEach((b) => (b.onclick = () => {
      fa.squad.value = b.dataset.apply;
      const nick = window.meuNick?.(); // já registrado: o nick vem do registro e o campo some
      fa.nick.value = nick || '';
      fa.nick.required = !nick;
      fa.nick.closest('.field').hidden = !!nick;
      document.getElementById('h-apply').textContent = t('Dar apply: {nome}', { nome: b.dataset.nome });
      say(fa.querySelector('.status'), '');
      dlg.showModal();
      ensureTS(fa.querySelector('.ts'));
    }));
  }

  // Avisos e táticas usam o mesmo formato de post
  const TIPOS = { aviso: ['avisos-list', 'Nenhum aviso por enquanto.', 'Não deu pra carregar os avisos.', 'Carregando avisos…'],
    tatica: ['taticas-list', 'Nenhuma tática publicada ainda.', 'Não deu pra carregar as táticas.', 'Carregando táticas…'] };
  function renderPosts(tipo) {
    const [boxId, vazio, erro, carregando] = TIPOS[tipo];
    const box = document.getElementById(boxId);
    const posts = D.posts[tipo];
    if (D.postsErr[tipo]) { box.innerHTML = `<p class="status bad">${esc(t(erro))} ${esc(tErr(D.postsErr[tipo]))}</p>`; return; }
    if (!posts) { box.innerHTML = `<p class="muted">${esc(t(carregando))}</p>`; return; }
    box.innerHTML = posts.length ? posts.map((p) => `
      <article class="post">
        <h2>${esc(p.titulo)}</h2>
        <p class="meta">${fmtDate(p.data)}</p>
        <div class="pre">${esc(p.texto)}</div>
        ${p.imgs.length ? `<div class="imgs">${p.imgs.map((id, i) => `<a href="${imgUrl(id)}" target="_blank" rel="noopener"><img src="${imgUrl(id)}" alt="${esc(t('Imagem {n} de {titulo}', { n: i + 1, titulo: p.titulo }))}" loading="lazy"></a>`).join('')}</div>` : ''}
      </article>`).join('') : `<p class="muted">${esc(t(vazio))}</p>`;
  }

  // Traduz os textos fixos do HTML (guarda o original em português pra poder voltar).
  // Áreas com data-dyn têm conteúdo do clã ou são redesenhadas pelo JS, então ficam de fora.
  function translateStatic() {
    const fora = (el) => el.closest('[data-dyn], script, style');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT,
      { acceptNode: (n) => (fora(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let n; (n = w.nextNode());) {
      n.ptText ??= n.nodeValue;
      const k = n.ptText.trim();
      if (k) n.nodeValue = n.ptText.replace(k, t(k));
    }
    for (const el of document.querySelectorAll('[placeholder], [aria-label], [alt], [title]')) {
      if (fora(el)) continue;
      el.ptAttr ??= {};
      for (const a of ['placeholder', 'aria-label', 'alt', 'title']) {
        if (!el.hasAttribute(a)) continue;
        el.ptAttr[a] ??= el.getAttribute(a);
        el.setAttribute(a, t(el.ptAttr[a]));
      }
    }
  }

  function renderAll() {
    renderFuso();
    renderGearTipos();
    renderRoles();
    recommend();
    renderConfig();
    renderSquads();
    renderPosts('aviso');
    renderPosts('tatica');
  }

  function setLang(l) {
    lang = l;
    try { localStorage.setItem('lang', l); } catch { /* sem storage: vale só nesta visita */ }
    document.documentElement.lang = LOCALE[l];
    document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.lang === l));
    document.querySelectorAll('.status').forEach((el) => say(el, '')); // mensagem antiga ficaria no idioma anterior
    renderAll();
    translateStatic();
  }
  document.querySelectorAll('[data-lang]').forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
  setLang(lang);

  api('/api/config').then((cfg) => { D.cfg = cfg; }, (e) => { D.cfgErr = e.message; })
    .then(() => { renderConfig(); renderGearTipos(); renderRoles(); recommend(); translateStatic(); });
  api('/api/squads').then((sq) => { D.squads = sq; }, (e) => { D.squadsErr = e.message; })
    .then(() => { renderSquads(); recommend(); });
  // táticas e avisos só pra membro: o membro.js chama depois do login
  window.carregarPosts = () => { for (const tipo of Object.keys(TIPOS)) {
    api('/api/posts?tipo=' + tipo, { token: window.tokenSite?.() }).then((p) => { D.posts[tipo] = p; }, (e) => { D.postsErr[tipo] = e.message; })
      .then(() => renderPosts(tipo));
  } };
  window.renderSquadsSite = renderSquads;
  window.D_SITE = D;
  window.SHOW_SITE = show;
}
