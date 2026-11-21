// Painel admin. O Worker confere o cargo em TODA rota; aqui a gente só esconde o que o cargo não usa.
const $ = (s, el = document) => el.querySelector(s);
const STATUS = { pendente: 'Pendente', recusado: 'Recusado', teste: 'Em teste', membro: 'Membro', veterano: 'Veterano', removido: 'Removido', suspenso: 'Sem acesso (suspenso)' };
const APROVADOS = ['teste', 'membro', 'veterano'];
// tags: [{ nome, visivel }]; a oculta aparece com cadeado e nunca sai do Worker pra membro
const tagOculta = (nome) => !D.tags.find((t) => t.nome === nome)?.visivel;
const tagTxt = (nome) => `${tagOculta(nome) ? '🔒 ' : ''}${nome}`;
const ATT = { presente: 'Presente', faltou: 'Faltou', justificou: 'Justificou' };
const RSVP = { vai: 'vai', talvez: 'talvez', nao: 'não vai' };
const DIAS = { seg: 'Seg', ter: 'Ter', qua: 'Qua', qui: 'Qui', sex: 'Sex', sab: 'Sáb', dom: 'Dom' };
const ROLE = { superadmin: 'Superadmin', admin: 'Admin', lider_squad: 'Líder de squad' };

const D = { members: [], squads: [], att: [], tags: [], cfg: null };
let sess = null;
try { sess = JSON.parse(localStorage.getItem('sess')); } catch { /* sem storage: só pede login */ }
let tabName = 'membros';
let redraw = () => {};

const isAdmin = () => sess?.role === 'superadmin' || sess?.role === 'admin';
const brDate = (d) => d.split('-').reverse().join('/');
const sqName = (id) => D.squads.find((s) => s.id === id)?.nome || '';
const opts = (pairs, sel) => pairs.map(([v, l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
// candidato = quem pediu pro squad do líder mas ainda não é dele (só leitura)
const active = () => D.members.filter((m) => APROVADOS.includes(m.status) && !m.candidato).sort((a, b) => a.nick.localeCompare(b.nick));
const pendentes = () => D.applies.filter((a) => a.status === 'pendente');
const msg = (t, bad) => say($('#msg'), t, bad);

function saveSess(s) {
  sess = s;
  try { s ? localStorage.setItem('sess', JSON.stringify(s)) : localStorage.removeItem('sess'); } catch { /* ignora */ }
}

async function call(path, opts = {}) {
  try {
    return await api('/api/admin/' + path, { ...opts, token: sess?.token });
  } catch (e) {
    if (e.status === 401) { saveSess(null); view('login'); say($('#f-login .status'), e.message, true); }
    throw e;
  }
}
// Mostra qualquer erro na faixa de status em vez de engolir.
const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.status !== 401) msg(e.message, true); } };

function view(name) {
  for (const v of ['login', 'senha', 'painel']) $('#v-' + v).hidden = v !== name;
  $('#sair').hidden = name === 'login';
  $('#quem').textContent = sess && name !== 'login' ? `${sess.name} (${ROLE[sess.role]})` : '';
}

function dlg(html) {
  const d = $('#dlg');
  d.innerHTML = html;
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => d.close()));
  if (!d.open) { d.showModal(); d.scrollTop = 0; } // redesenhar com o diálogo aberto (ex.: trocar o período) não fecha nem rola
}

// ---------- período: Dia / Mês / Season / All time, o mesmo em todas as telas ----------
const hojeLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const seasonDaData = (date) => (D.cfg.seasons || []).find((s) => s.inicio <= date && date <= s.fim)?.id || '';
const nomeSeason = (id) => (D.cfg.seasons || []).find((s) => s.id === id)?.nome || '';
let periodo = null; // { tipo: 'dia' | 'mes' | 'season' | 'tudo', valor }
const periodoPadrao = () => (D.cfg.seasonAtual ? { tipo: 'season', valor: D.cfg.seasonAtual } : { tipo: 'mes', valor: hojeLocal().slice(0, 7) });
// registro antigo sem season: deduz pela data
function noPeriodo(date, season) {
  if (periodo.tipo === 'tudo') return true;
  if (periodo.tipo === 'dia') return date === periodo.valor;
  if (periodo.tipo === 'mes') return date.startsWith(periodo.valor);
  return (season || seasonDaData(date)) === periodo.valor;
}
// Desenha o seletor dentro de box; px separa os ids quando há dois na tela (aba + ficha).
function montarPeriodo(box, px, onChange, foco) {
  const meses = mesesAte([...D.att, ...D.results].map((x) => x.date.slice(0, 7)), hojeLocal().slice(0, 7));
  const seasons = (D.cfg.seasons || []).slice().reverse();
  const valor = {
    dia: `<input type="date" id="${px}-v" value="${esc(periodo.valor)}">`,
    mes: `<select id="${px}-v">${opts(meses.map((m) => [m, nomeMes(m)]), periodo.valor)}</select>`,
    season: seasons.length ? `<select id="${px}-v">${opts(seasons.map((s) => [s.id, s.nome + (s.id === D.cfg.seasonAtual ? ' (atual)' : '')]), periodo.valor)}</select>` : '',
  }[periodo.tipo];
  box.innerHTML = `<div class="periodo">
    <div class="field"><label for="${px}-t">Período</label><select id="${px}-t">${opts([['dia', 'Dia'], ['mes', 'Mês'], ['season', 'Season'], ['tudo', 'All time']], periodo.tipo)}</select></div>
    ${valor ? `<div class="field"><label for="${px}-v">${{ dia: 'Data', mes: 'Mês', season: 'Season' }[periodo.tipo]}</label>${valor}</div>` : ''}
    ${periodo.tipo === 'season' && !seasons.length ? '<p class="muted">Nenhuma season criada ainda. O superadmin cria na aba Config.</p>' : ''}
  </div>`;
  const mudou = (qual) => { montarPeriodo(box, px, onChange, qual); onChange(); };
  $(`#${px}-t`, box).onchange = (e) => {
    const tipo = e.target.value;
    periodo = { tipo, valor: { dia: hojeLocal(), mes: hojeLocal().slice(0, 7), season: D.cfg.seasonAtual || seasons[0]?.id || '', tudo: '' }[tipo] };
    mudou('t');
  };
  const v = $(`#${px}-v`, box);
  if (v) v.onchange = () => { periodo = { ...periodo, valor: v.value }; mudou('v'); };
  if (foco) $(`#${px}-${foco}`, box)?.focus();
}

// ---------- KDA: Rating = (Kill + Assist) / Death, com Death mínimo 1 ----------
const rating = (s) => (s.k + s.a) / Math.max(s.d, 1);
const fmtKda = (s) => `Kill (${s.k}) / Death (${s.d}) / Assist (${s.a}) / Rating (${rating(s).toFixed(2)})`;
// soma do membro nos games do período (e do modo, se escolhido)
function kda(memberId, modo = '') {
  const s = { k: 0, d: 0, a: 0, jogos: 0 };
  for (const r of D.results) {
    if (!noPeriodo(r.date, r.season) || (modo && r.modo !== modo)) continue;
    const l = r.linhas.find((x) => x.memberId === memberId);
    if (l) { s.k += l.kills; s.d += l.deaths; s.a += l.assists; s.jogos++; }
  }
  return s;
}

// Inativo: X faltas seguidas ou Y dias sem presença (Config). Calculado na hora; o Worker usa a mesma regra no Discord.
// Devolve o motivo em texto, ou null.
function inativo(m) {
  if (!['teste', 'membro', 'veterano'].includes(m.status)) return null;
  const marcadas = D.att.filter((a) => a.marks[m.id]?.s).sort((a, b) => b.date.localeCompare(a.date));
  let seguidas = 0;
  for (const a of marcadas) { if (a.marks[m.id].s === 'faltou') seguidas++; else break; }
  const ultima = marcadas.find((a) => a.marks[m.id].s === 'presente')?.date || m.criadoEm.slice(0, 10);
  const dias = Math.floor((Date.parse(hojeLocal()) - Date.parse(ultima)) / 864e5);
  const motivos = [];
  if (seguidas >= (D.cfg.inativoFaltas || 3)) motivos.push(`${seguidas} ${seguidas === 1 ? 'falta seguida' : 'faltas seguidas'}`);
  if (dias >= (D.cfg.inativoDias || 14)) motivos.push(`${dias} ${dias === 1 ? 'dia' : 'dias'} sem presença`);
  return motivos.length ? motivos.join(' e ') : null;
}

// frequência no período escolhido
function freq(id) {
  const c = { presente: 0, faltou: 0, justificou: 0, ocorrencias: 0 };
  for (const a of D.att) {
    const mk = a.marks[id];
    if (!mk || !noPeriodo(a.date, a.season)) continue;
    if (mk.s) c[mk.s]++;
    c.ocorrencias += mk.o?.length || 0;
  }
  const t = c.presente + c.faltou + c.justificou;
  return { ...c, t, pct: t ? Math.round((100 * c.presente) / t) : null, low: t >= 3 && (100 * c.presente) / t < 60 };
}
// Todos os meses do primeiro com presença marcada até o atual, sem pular os vazios (mais novo primeiro).
function mesesAte(marcados, atual) {
  const inicio = [...marcados, atual].sort()[0];
  const out = [];
  for (let [y, m] = inicio.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= atual; m === 12 ? (y++, m = 1) : m++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out.reverse();
}
const nomeMes = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5) - 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
const GUERRA = { '': 'Dia todo', 1: '1ª guerra', 2: '2ª guerra', 3: '3ª guerra' };
const obsLi = (o) => `<li data-g="${esc(o.g)}" data-t="${esc(o.t)}">${GUERRA[o.g] || GUERRA['']}: ${esc(o.t)}
  <button type="button" class="linkish" data-rm-obs aria-label="Remover ocorrência: ${esc(o.t)}">remover</button></li>`;
const fmtFreq = (f) => (f.t
  ? `<span class="${f.low ? 'low' : ''}">${f.pct}% (${f.presente}/${f.t})${f.low ? ', falta muito' : ''}</span>`
  : '<span class="muted">sem guerras</span>');

// ---------- login ----------
$('#f-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const st = $('.status', f);
  try {
    saveSess(await api('/api/admin/login', { method: 'POST', body: { user: f.user.value, pass: f.pass.value } }));
  } catch (err) {
    return say(st, err.message, true);
  }
  f.reset();
  say(st, '');
  start();
});

$('#f-senha').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const st = $('.status', f);
  if (f.nova.value !== f.conf.value) return say(st, 'As duas senhas novas não são iguais.', true);
  try {
    saveSess(await call('password', { method: 'POST', body: { atual: f.atual.value, nova: f.nova.value } }));
    f.reset();
    say(st, '');
    start();
  } catch (err) {
    if (err.status !== 401) say(st, err.message, true);
  }
});

$('#sair').onclick = () => {
  call('logout', { method: 'POST' }).catch(() => {});
  saveSess(null);
  view('login');
};

function start() {
  if (sess.mustChange) return view('senha');
  run(openPanel)();
}

async function reload() {
  [D.members, D.squads, D.att, D.tags, D.cfg, D.applies, D.results] = await Promise.all([
    call('members'), call('squads'), call('attendance'), call('tags'), api('/api/config'), call('applies'), call('results'),
  ]);
  periodo ||= periodoPadrao();
  const np = D.members.filter((m) => m.status === 'pendente').length;
  $('[data-tab=pendentes]').textContent = np ? `Pendentes (${np})` : 'Pendentes';
  const n = pendentes().length;
  $('[data-tab=squads]').textContent = n ? `Squads (${n} ${n === 1 ? 'pedido' : 'pedidos'})` : 'Squads';
}

async function openPanel() {
  view('painel');
  document.querySelectorAll('[data-tab]').forEach((b) => (b.hidden = !b.dataset.roles.split(' ').includes(sess.role)));
  msg('Carregando…');
  await reload();
  showTab(tabName); // showTab limpa a mensagem, então o aviso vem depois
  const fichaId = location.hash.match(/^#ficha\/([0-9a-f-]{36})$/)?.[1];
  if (fichaId && D.members.some((x) => x.id === fichaId)) ficha(fichaId);
  const p = pendentes();
  msg(p.length ? `${p.slice(0, 3).map((a) => a.nick).join(', ')}${p.length > 3 ? ` e mais ${p.length - 3}` : ''} ${p.length === 1 ? 'pediu' : 'pediram'} pra jogar ${sess.role === 'lider_squad' ? 'no seu squad' : 'num squad'}. Veja na aba Squads.` : '');
}

document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function showTab(name) {
  if ($(`[data-tab="${name}"]`).hidden) name = 'membros';
  tabName = name;
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === name));
  $('#tab').onclick = null;
  $('#tab').onchange = null;
  $('#tab').oninput = null;
  msg('');
  run(TABS[name])();
}

// ---------- abas ----------
const TABS = {
  membros() {
    const T = $('#tab');
    const playstyles = [...new Set([...D.cfg.playstyles.map((p) => p.nome), ...D.members.flatMap((m) => m.playstyles)])];
    const gearTiposAll = [...new Set([...(D.cfg.gearTipos || []), ...D.members.flatMap((m) => m.gearTipos || [])])];
    T.innerHTML = `<h1>Membros</h1>
      <div id="m-per"></div>
      <div class="filters">
        <div class="field"><label for="f-gt">Tipo de gear</label><select id="f-gt"><option value="">Todos</option>${opts(gearTiposAll.map((g) => [g, g]))}</select></div>
        <label class="check"><input type="checkbox" id="f-inat"> Só inativos</label>
        <div class="field"><label for="f-q">Buscar</label><input id="f-q" type="search" placeholder="Nick ou Discord"></div>
        <div class="field"><label for="f-dia">Dia disponível</label><select id="f-dia"><option value="">Todos</option>${opts(Object.entries(DIAS))}</select></div>
        <div class="field"><label for="f-ps">Função</label><select id="f-ps"><option value="">Todos</option>${opts(playstyles.map((p) => [p, p]))}</select></div>
        <div class="field"><label for="f-sq">Squad (desejado ou atual)</label><select id="f-sq"><option value="">Todos</option>${opts(D.squads.map((s) => [s.id, s.nome]))}</select></div>
        <div class="field"><label for="f-st">Status</label><select id="f-st"><option value="">Ativos (em teste, membro, veterano)</option>${opts(Object.entries(STATUS))}</select></div>
        <div class="field"><label for="f-tag">Tag</label><select id="f-tag"><option value="">Todas</option>${opts(D.tags.map((t) => [t.nome, tagTxt(t.nome)]))}</select></div>
      </div>
      <p class="muted" id="m-count"></p>
      <div class="table-wrap"><table>
        <thead><tr><th>Nick</th><th>Discord</th><th>Fuso</th><th>Gear</th><th>Status</th><th>Squad</th><th>Nota</th><th>Frequência</th><th>Rating (KDA)</th><th>Tags</th></tr></thead>
        <tbody id="m-rows"></tbody>
      </table></div>`;
    const draw = () => {
      const q = $('#f-q').value.toLowerCase();
      const [dia, ps, sq, st, tag, gt] = ['#f-dia', '#f-ps', '#f-sq', '#f-st', '#f-tag', '#f-gt'].map((s) => $(s).value);
      const rows = D.members.filter((m) => !m.candidato)
        .filter((m) => (!q || `${m.nick} ${m.discord}`.toLowerCase().includes(q))
          && (!gt || (m.gearTipos || []).includes(gt))
          && (!$('#f-inat').checked || inativo(m))
          && (!dia || m.dias.includes(dia))
          && (!ps || m.playstyles.includes(ps))
          && (!sq || m.squad === sq || m.squadDesejado === sq)
          && (st ? m.status === st : APROVADOS.includes(m.status))
          && (!tag || m.tags.includes(tag)))
        .sort((a, b) => a.nick.localeCompare(b.nick));
      $('#m-count').textContent = `${rows.length} ${rows.length === 1 ? 'membro' : 'membros'}`;
      $('#m-rows').innerHTML = rows.map((m) => {
        const k = kda(m.id);
        return `<tr>
        <td><button type="button" class="linkish" data-ficha="${esc(m.id)}">${esc(m.nick)}</button></td>
        <td>${esc(m.discord)}</td>
        <td>${esc(m.fuso)}</td>
        <td>${esc((m.gearTipos || []).join(', ')) || '<span class="muted">-</span>'}</td>
        <td>${STATUS[m.status]}${inativo(m) ? ` <span class="pill inativo" title="${esc(inativo(m))}">inativo<span class="sr-only">: ${esc(inativo(m))}</span></span>` : ''}</td>
        <td>${esc(sqName(m.squad)) || '<span class="muted">-</span>'}</td>
        <td>${esc(m.nota ?? '-')}</td>
        <td>${fmtFreq(freq(m.id))}</td>
        <td>${k.jogos ? `<span title="${esc(fmtKda(k))}">${rating(k).toFixed(2)}</span>` : '<span class="muted">-</span>'}</td>
        <td>${m.tags.map((t) => `<span class="pill"${tagOculta(t) ? ' title="Oculta: só a equipe vê"' : ''}>${esc(tagTxt(t))}</span>`).join(' ')}</td>
      </tr>`;
      }).join('') || '<tr><td colspan="10" class="muted">Nenhum membro com esses filtros.</td></tr>';
    };
    T.querySelectorAll('.filters input, .filters select').forEach((el) => (el.oninput = draw));
    montarPeriodo($('#m-per'), 'mp', draw);
    if (isAdmin()) {
      $('#m-count').insertAdjacentHTML('beforebegin', '<div class="actions"><button type="button" data-tags>Gerenciar tags</button></div>');
      $('[data-tags]').onclick = tagsForm;
    }
    T.onclick = (e) => { const id = e.target.closest('[data-ficha]')?.dataset.ficha; if (id) ficha(id); };
    redraw = draw;
    draw();
  },

  async presenca() {
    const T = $('#tab');
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    T.innerHTML = `<h1>Presença em guerra</h1>
      <form id="f-pres">
        <div class="field narrow"><label for="p-date">Data da guerra</label><input id="p-date" type="date" value="${today}" required></div>
        <p class="muted">Cada dia tem 3 guerras. Em "Ocorrência", escreva o que aconteceu (ou escolha uma sugestão), diga em qual guerra foi e clique em Adicionar. Tudo é gravado ao clicar em Salvar presença.</p>
        <datalist id="obs-sugestoes">
          <option value="Deu que ia e não veio"><option value="Ficou AFK farmando ponto"><option value="Saiu no meio da guerra">
          <option value="Chegou atrasado"><option value="Não seguiu a call"><option value="Jogou muito bem">
        </datalist>
        <div id="p-rows"></div>
        <div class="actions"><button class="primary" type="submit">Salvar presença</button><button type="button" data-repost-pres hidden>Repostar presença no Discord</button></div>
      </form>
      <h2>Frequência</h2>
      <div id="p-per"></div>
      <p class="muted">Em vermelho: menos de 60% de presença, com 3 dias de guerra ou mais marcados.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Nick</th><th>Presente</th><th>Faltou</th><th>Justificou</th><th>Frequência</th><th>Ocorrências</th></tr></thead>
        <tbody id="p-freq"></tbody>
      </table></div>`;
    const drawFreq = () => {
      $('#p-freq').innerHTML = active().map((m) => {
        const f = freq(m.id);
        return `<tr><td>${esc(m.nick)}</td><td>${f.presente}</td><td>${f.faltou}</td><td>${f.justificou}</td><td>${fmtFreq(f)}</td><td>${f.ocorrencias || '-'}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">Nenhum membro ativo.</td></tr>';
    };
    montarPeriodo($('#p-per'), 'pp', drawFreq);
    const drawRows = async () => {
      const date = $('#p-date').value;
      if (!date) return;
      const marks = D.att.find((a) => a.date === date)?.marks || {};
      const rsvp = await call('rsvp?date=' + date).catch(() => []);
      const rs = Object.fromEntries(rsvp.map((r) => [r.nick.toLowerCase(), r.status]));
      $('#p-rows').innerHTML = active().map((m) => {
        const mk = marks[m.id] || { s: '', j: '', o: [] };
        const r = rs[m.nick.toLowerCase()];
        const id = esc(m.id);
        return `<div class="att-row" data-id="${id}">
          <div><strong>${esc(m.nick)}</strong> ${r ? `<span class="pill ${r}">Bot: ${RSVP[r]}</span>` : ''}</div>
          <fieldset><legend class="sr-only">Presença de ${esc(m.nick)}</legend><div class="options">
            ${[['', 'Sem marcação'], ...Object.entries(ATT)].map(([v, l]) => `<label class="check"><input type="radio" name="s-${id}" value="${v}"${mk.s === v ? ' checked' : ''}> ${l}</label>`).join('')}
          </div></fieldset>
          <label class="sr-only" for="j-${id}">Justificativa de ${esc(m.nick)}</label>
          <input type="text" class="just" id="j-${id}" maxlength="300" placeholder="Justificativa (se justificou)" value="${esc(mk.j)}">
          <ul class="obs">${(mk.o || []).map(obsLi).join('')}</ul>
          <div class="obs-add">
            <label class="sr-only" for="og-${id}">Em qual guerra foi a ocorrência de ${esc(m.nick)}</label>
            <select id="og-${id}">${Object.entries(GUERRA).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
            <label class="sr-only" for="ot-${id}">Ocorrência de ${esc(m.nick)}</label>
            <input type="text" id="ot-${id}" list="obs-sugestoes" maxlength="200" placeholder="Ocorrência (ex.: ficou AFK)">
            <button type="button" data-add-obs>Adicionar</button>
          </div>
        </div>`;
      }).join('') || '<p class="muted">Nenhum membro ativo.</p>';
    };
    const addObs = (row) => {
      const inp = $('.obs-add input', row);
      if (!inp.value.trim()) return inp.focus();
      $('.obs', row).insertAdjacentHTML('beforeend', obsLi({ g: $('.obs-add select', row).value, t: inp.value.trim() }));
      inp.value = '';
      inp.focus();
    };
    $('#p-rows').onclick = (e) => {
      if (e.target.closest('[data-add-obs]')) addObs(e.target.closest('.att-row'));
      if (e.target.closest('[data-rm-obs]')) {
        const row = e.target.closest('.att-row');
        e.target.closest('li').remove();
        $('.obs-add input', row).focus();
      }
    };
    // Enter na ocorrência adiciona em vez de salvar o formulário inteiro
    $('#p-rows').onkeydown = (e) => {
      if (e.key === 'Enter' && e.target.matches('.obs-add input')) { e.preventDefault(); addObs(e.target.closest('.att-row')); }
    };
    $('#p-date').onchange = run(drawRows);
    $('#f-pres').onsubmit = run(async (e) => {
      e.preventDefault();
      const date = $('#p-date').value;
      const marks = {};
      for (const row of document.querySelectorAll('.att-row')) {
        const s = $('input[type=radio]:checked', row)?.value || '';
        const j = $('.just', row).value.trim();
        if (s === 'justificou' && !j) {
          $('.just', row).focus();
          return msg('Escreva a justificativa de quem justificou.', true);
        }
        if ($('.obs-add input', row).value.trim()) addObs(row); // digitou e esqueceu de clicar Adicionar
        const o = [...row.querySelectorAll('.obs li')].map((li) => ({ g: li.dataset.g, t: li.dataset.t }));
        marks[row.dataset.id] = { s, j, o };
      }
      const salvo = await call('attendance', { method: 'POST', body: { date, marks } });
      D.att = await call('attendance');
      msg(`Presença de ${brDate(date)} salva. ${DISC_TXT[salvo.discord?.presenca] || ''}`);
      $('[data-repost-pres]').hidden = !(isAdmin() && salvo.discord?.presenca === 'ja');
      $('[data-repost-pres]').onclick = run(async () => {
        await call('discord-postar', { method: 'POST', body: { tipo: 'presenca', date } });
        $('[data-repost-pres]').hidden = true;
        msg('Presença repostada no Discord.');
      });
      drawFreq();
    });
    drawFreq();
    await drawRows();
  },

  async squads() {
    const T = $('#tab');
    const admin = isAdmin();
    const lider = sess.role === 'lider_squad';
    const byDate = (a, b) => b.data.localeCompare(a.data);
    const pend = pendentes().sort(byDate);
    const done = D.applies.filter((a) => a.status !== 'pendente').sort(byDate).slice(0, 30);
    const porNick = (nick) => D.members.find((m) => m.nick.toLowerCase() === nick.toLowerCase());
    const pode = (s) => admin || s.id === sess.squad;
    const membrosDo = (s) => D.members.filter((m) => m.squad === s.id && m.status !== 'removido' && !m.candidato).sort((a, b) => a.nick.localeCompare(b.nick));
    T.innerHTML = `<h1>${lider && D.squads[0] ? `Seu squad: ${esc(D.squads[0].nome)}` : 'Squads'}</h1>
      <h2>${lider ? 'Pedidos pro seu squad' : 'Pedidos esperando resposta'} (${pend.length})</h2>
      ${pend.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Nick</th>${lider ? '' : '<th>Squad</th>'}<th>Como pediu</th><th>Mensagem</th><th>Data</th><th>Resposta</th></tr></thead>
        <tbody>${pend.map((a) => `<tr>
          <td>${porNick(a.nick) ? `<button type="button" class="linkish" data-ficha="${esc(porNick(a.nick).id)}">${esc(a.nick)}</button>` : esc(a.nick)}</td>
          ${lider ? '' : `<td>${esc(sqName(a.squad))}</td>`}
          <td>${a.origem === 'registro' ? 'Escolheu no registro' : 'Deu apply'}</td>
          <td class="pre">${a.origem === 'registro' ? '' : esc(a.msg)}</td><td>${fmtDate(a.data)}</td>
          <td><div class="actions"><button type="button" class="primary" data-ok="${esc(a.id)}">Aceitar</button><button type="button" data-no="${esc(a.id)}">Recusar</button></div></td></tr>`).join('')}</tbody>
      </table></div>` : `<p class="muted">Ninguém pediu pra entrar ${lider ? 'no seu squad' : 'num squad'} agora.</p>`}
      <h2>${lider ? 'Membros' : 'Todos os squads'}</h2>
      ${admin ? '<div class="actions"><button type="button" class="primary" data-novo>Novo squad</button></div><br>' : ''}
      <div class="grid">${D.squads.map((s) => {
        const ms = membrosDo(s);
        const nRes = ms.filter((m) => m.vaga === 'reserva').length;
        return `<article class="card">
        ${s.builds?.length || s.funcoes?.length ? `<div class="procura">
          ${s.builds?.length ? `<p>Procura builds: ${esc(fmtBuilds(s.builds))}</p>` : ''}
          ${s.funcoes?.length ? `<p>Procura funções: ${s.funcoes.map(esc).join(', ')}</p>` : ''}
        </div>` : ''}
        <h2>${esc(s.nome)}</h2>
        ${s.estilo ? `<p class="meta">${esc(s.estilo)}</p>` : ''}
        <p class="meta">Líder: ${esc(s.lider || 'a definir')}</p>
        ${pode(s) ? `<div><button type="button" data-procura="${esc(s.id)}">O que o squad procura</button></div>` : ''}
        <p><span class="count">${ms.length - nRes}</span> <span class="muted">${ms.length - nRes === 1 ? 'fixo' : 'fixos'}, ${nRes} ${nRes === 1 ? 'reserva' : 'reservas'}</span></p>
        ${ms.length ? `<ul class="vagas">${ms.map((m) => `<li><span>${esc(m.nick)}</span>${pode(s)
          ? `<span class="vaga-acoes"><select data-vaga="${esc(m.id)}" aria-label="Vaga de ${esc(m.nick)}">${opts([['fixo', 'Fixo'], ['reserva', 'Reserva']], m.vaga === 'reserva' ? 'reserva' : 'fixo')}</select>
            <button type="button" class="linkish" data-tirar="${esc(m.id)}" aria-label="Tirar ${esc(m.nick)} do squad">tirar</button></span>`
          : `<span class="muted">${m.vaga === 'reserva' ? 'Reserva' : 'Fixo'}</span>`}</li>`).join('')}</ul>` : '<p class="muted">Ninguém no squad ainda.</p>'}
        ${admin ? `<div class="actions"><button type="button" data-edit="${esc(s.id)}">Editar</button><button type="button" class="danger" data-del="${esc(s.id)}">Apagar</button></div>` : ''}
      </article>`;
      }).join('') || '<p class="muted">Nenhum squad ainda.</p>'}</div>
      ${done.length ? `<h2>Pedidos respondidos</h2><ul>${done.map((a) => `<li>${esc(a.nick)} em ${esc(sqName(a.squad))}: ${esc(a.status)} por ${esc(a.por)} (${fmtDate(a.data)})</li>`).join('')}</ul>` : ''}`;
    // fixo/reserva salva na hora que muda
    T.onchange = run(async (e) => {
      const sel = e.target.closest('[data-vaga]');
      if (!sel) return;
      const m = await call('member', { method: 'POST', body: { id: sel.dataset.vaga, vaga: sel.value } });
      Object.assign(D.members.find((x) => x.id === m.id), m);
      D.squads = await call('squads');
      await TABS.squads();
      msg(`${m.nick} agora é ${m.vaga === 'reserva' ? 'reserva' : 'fixo'}.`);
    });
    T.onclick = run(async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.ficha) return ficha(b.dataset.ficha);
      if (b.dataset.procura) return procuraForm(D.squads.find((s) => s.id === b.dataset.procura));
      if (b.dataset.tirar) {
        const m = D.members.find((x) => x.id === b.dataset.tirar);
        if (!confirm(`Tirar ${m.nick} do squad ${sqName(m.squad)}? Ele continua no clã, só fica sem squad.`)) return;
        Object.assign(m, await call('member', { method: 'POST', body: { id: m.id, tirarDoSquad: true } }));
        D.squads = await call('squads');
        await TABS.squads();
        return msg(`${m.nick} saiu do squad.`);
      }
      if (b.hasAttribute('data-novo')) return squadForm();
      if (b.dataset.edit) return squadForm(D.squads.find((s) => s.id === b.dataset.edit));
      if (b.dataset.del) {
        const s = D.squads.find((x) => x.id === b.dataset.del);
        if (!confirm(`Apagar o squad ${s.nome}? Os membros ficam sem squad.`)) return;
        await call('squad?id=' + s.id, { method: 'DELETE' });
        await reload();
        msg(`Squad ${s.nome} apagado.`);
        return TABS.squads();
      }
      if (b.dataset.ok || b.dataset.no) {
        const a = await call('apply', { method: 'POST', body: { id: b.dataset.ok || b.dataset.no, aceitar: !!b.dataset.ok } });
        await reload();
        await TABS.squads();
        msg(`Pedido de ${a.nick} ${a.status}.`);
      }
    });
  },

  async pendentes() {
    const T = $('#tab');
    const ps = D.members.filter((m) => m.status === 'pendente').sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
    const recusados = D.members.filter((m) => m.status === 'recusado');
    T.innerHTML = `<h1>Pendentes</h1>
      <p class="muted">Registro novo entra aqui. Aprovar coloca como "em teste" e libera o acesso de membro no site. Recusar tira o acesso; o motivo é só interno.</p>
      ${ps.length ? `<div class="table-wrap"><table><thead><tr><th>Nick</th><th>Discord</th><th>Registrou em</th><th>Resposta</th></tr></thead><tbody>
        ${ps.map((m) => `<tr><td><button type="button" class="linkish" data-ficha="${esc(m.id)}">${esc(m.nick)}</button></td><td>${esc(m.discord)}</td><td>${fmtDate(m.criadoEm)}</td>
          <td><div class="actions"><button type="button" class="primary" data-aprovar="${esc(m.id)}">Aprovar</button><button type="button" data-recusar="${esc(m.id)}">Recusar</button></div></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Nenhum registro esperando aprovação.</p>'}
      ${recusados.length ? `<h2>Recusados</h2><ul>${recusados.map((m) => `<li><button type="button" class="linkish" data-ficha="${esc(m.id)}">${esc(m.nick)}</button>${m.motivoRecusa ? `: ${esc(m.motivoRecusa)}` : ''} <button type="button" class="linkish" data-aprovar="${esc(m.id)}">aprovar mesmo assim</button></li>`).join('')}</ul>` : ''}`;
    T.onclick = run(async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.ficha) return ficha(b.dataset.ficha);
      const id = b.dataset.aprovar || b.dataset.recusar;
      if (!id) return;
      const m = D.members.find((x) => x.id === id);
      const motivo = b.dataset.recusar ? prompt(`Recusar ${m.nick}? Motivo (opcional, o membro vê):`, '') : '';
      if (motivo === null) return;
      Object.assign(m, await call('approve', { method: 'POST', body: { id, aprovar: !!b.dataset.aprovar, motivo } }));
      await reload();
      await TABS.pendentes();
      msg(`${m.nick} ${b.dataset.aprovar ? 'aprovado: já tem acesso de membro' : 'recusado'}.`);
    });
  },

  resultados() {
    const T = $('#tab');
    const admin = isAdmin();
    const modos = () => [...new Set([...Object.values(D.cfg.modos || {}), ...D.results.map((r) => r.modo)].filter(Boolean))];
    const modoDoDia = (date) => D.cfg.modos?.[['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'][new Date(date + 'T12:00').getDay()]] || '';
    T.innerHTML = `<h1>Resultados / KDA</h1>
      <p class="muted">KDA = Kill (X) / Death (Y) / Assist (Z) / Rating ((X + Z) / Y). Sem morte, divide por 1.</p>
      <h2>Lançar ou editar um game</h2>
      <form id="f-game" class="row">
        <div class="field"><label for="r-date">Data</label><input type="date" id="r-date" value="${hojeLocal()}" required></div>
        <div class="field"><label for="r-modo">Modo</label><input type="text" id="r-modo" maxlength="40" list="r-modos" value="${esc(modoDoDia(hojeLocal()))}">
          <datalist id="r-modos">${modos().map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div>
        <div class="field"><label for="r-game">Game</label><select id="r-game">${opts([['1', 'Game 1'], ['2', 'Game 2'], ['3', 'Game 3']])}</select></div>
        <div class="field"><span aria-hidden="true">&nbsp;</span><button type="submit">Abrir game</button></div>
      </form>
      <div id="r-editor"></div>
      <h2>Games salvos</h2>
      <div id="r-per"></div>
      <div class="field narrow"><label for="r-fmodo">Modo</label><select id="r-fmodo"><option value="">Todos</option>${opts(modos().map((m) => [m, m]))}</select></div>
      <div class="ordem" role="group" aria-label="Ordenar jogadores">
        <span>Ordenar por:</span>
        <button type="button" data-ordem="">Média de kills (padrão)</button>
        <button type="button" data-ordem="kills">Kill</button>
        <button type="button" data-ordem="deaths">Death</button>
        <button type="button" data-ordem="assists">Assist</button>
        <button type="button" data-ordem="kd">KD</button>
      </div>
      <p class="muted" id="r-ordem-txt" aria-live="polite"></p>
      <div id="r-lista"></div>
      <h2>Ranking por KDA</h2>
      <p class="muted">Mesmo período, modo e ordem escolhidos acima.</p>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Nick</th><th>Games</th><th>KDA</th></tr></thead><tbody id="r-rank"></tbody></table></div>`;

    // ---- ordem: 1º clique = maior primeiro, 2º = menor primeiro. Sem clique: maior média de kills por game ----
    let ordem = { campo: '', dir: -1 };
    const NOME_ORDEM = { kills: 'Kill', deaths: 'Death', assists: 'Assist', kd: 'KD' };
    const valor = (s, campo) => ({ kills: s.k, deaths: s.d, assists: s.a, kd: rating(s) })[campo];
    // itens: [{ nick, s: { k, d, a, jogos } }]; KD alto com poucas kills (ex.: 6/0) não passa quem fez 27/10 no padrão
    const ordenar = (itens) => itens.sort((x, y) => (ordem.campo
      ? (valor(x.s, ordem.campo) - valor(y.s, ordem.campo)) * ordem.dir || y.s.k - x.s.k
      : y.s.k / (y.s.jogos || 1) - x.s.k / (x.s.jogos || 1) || rating(y.s) - rating(x.s)));
    const linhasOrdenadas = (linhas) => ordenar(linhas.map((l) => ({ nick: l.nick, s: { k: l.kills, d: l.deaths, a: l.assists, jogos: l.jogos || 1 } })));
    const li = (x) => `<li>${esc(x.nick)}: ${esc(fmtKda(x.s))}${x.s.jogos > 1 ? ` <span class="muted">(${x.s.jogos} games)</span>` : ''}</li>`;

    // ---- lista de games salvos (por dia) e ranking ----
    const drawLista = () => {
      const modo = $('#r-fmodo').value;
      document.querySelectorAll('[data-ordem]').forEach((b) => {
        const ativo = b.dataset.ordem === ordem.campo;
        b.setAttribute('aria-pressed', ativo);
        if (b.dataset.ordem) b.textContent = NOME_ORDEM[b.dataset.ordem] + (ativo ? (ordem.dir < 0 ? ' ↓' : ' ↑') : '');
      });
      $('#r-ordem-txt').textContent = ordem.campo
        ? `${NOME_ORDEM[ordem.campo]}: ${ordem.dir < 0 ? 'do maior pro menor' : 'do menor pro maior'}. Clique de novo pra inverter.`
        : 'Padrão: maior média de kills por game primeiro (empate: maior KD).';
      // mantém aberto o que estava aberto ao reordenar
      const abertos = new Set([...document.querySelectorAll('#r-lista details[open]')].map((x) => x.dataset.k));
      const rs = D.results.filter((r) => noPeriodo(r.date, r.season) && (!modo || r.modo === modo))
        .sort((a, b) => b.date.localeCompare(a.date) || a.game - b.game);
      const dias = [...new Set(rs.map((r) => r.date))];
      $('#r-lista').innerHTML = dias.map((d) => {
        const doDia = rs.filter((r) => r.date === d);
        // resumo do dia: soma dos games de cada jogador
        const soma = {};
        for (const r of doDia) for (const l of r.linhas) {
          const s = (soma[l.memberId] ||= { nick: l.nick, kills: 0, deaths: 0, assists: 0, jogos: 0 });
          s.kills += l.kills; s.deaths += l.deaths; s.assists += l.assists; s.jogos++;
        }
        const k = (x) => esc(`${d}|${x}`);
        return `<div class="card"><h3>${esc(brDate(d))}</h3>
          ${doDia.map((r) => `<details data-k="${k(r.game)}"${abertos.has(`${d}|${r.game}`) ? ' open' : ''}><summary>Game ${esc(r.game)}${r.modo ? ` (${esc(r.modo)})` : ''}: ${r.linhas.length} ${r.linhas.length === 1 ? 'jogador' : 'jogadores'}, salvo por ${esc(r.por)}</summary>
            <ul>${linhasOrdenadas(r.linhas).map(li).join('') || '<li class="muted">Sem linhas.</li>'}</ul>
            <div class="actions"><button type="button" data-abrir="${esc(r.date)}|${esc(r.game)}">Abrir e editar</button>${admin ? `<button type="button" class="danger" data-apagar="${esc(r.date)}|${esc(r.game)}">Apagar game</button>` : ''}</div>
          </details>`).join('')}
          ${doDia.length > 1 ? `<details data-k="${k('dia')}"${abertos.has(`${d}|dia`) ? ' open' : ''}><summary>Resumo do dia (todos os games)</summary><ul>${linhasOrdenadas(Object.values(soma)).map(li).join('')}</ul></details>` : ''}
        </div>`;
      }).join('') || '<p class="muted">Nenhum game salvo nesse período.</p>';
      const rank = ordenar(active().map((m) => ({ nick: m.nick, s: kda(m.id, modo) })).filter((x) => x.s.jogos));
      $('#r-rank').innerHTML = rank.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.nick)}</td><td>${x.s.jogos}</td><td>${esc(fmtKda(x.s))}</td></tr>`).join('')
        || '<tr><td colspan="4" class="muted">Ninguém jogou nesse período.</td></tr>';
    };
    $('#r-fmodo').onchange = drawLista;
    document.querySelector('.ordem').onclick = (e) => {
      const b = e.target.closest('[data-ordem]');
      if (!b) return;
      const campo = b.dataset.ordem;
      ordem = !campo ? { campo: '', dir: -1 } : ordem.campo === campo ? { campo, dir: -ordem.dir } : { campo, dir: -1 };
      drawLista();
    };
    montarPeriodo($('#r-per'), 'rp', drawLista);
    drawLista();

    // ---- editor de um game: prints → leitura → revisão → salvar ----
    let atual = null; // { date, game, prints }
    let picker = null;
    $('#r-date').onchange = () => { $('#r-modo').value = modoDoDia($('#r-date').value); };
    const linhaHtml = (l) => `<tr>
      <td><input type="text" data-f="nick" maxlength="32" aria-label="Nick lido" value="${esc(l.nick || '')}"></td>
      <td><select data-f="memberId" aria-label="Membro do clã"><option value="">Ignorar (inimigo)</option>${opts(active().map((m) => [m.id, m.nick]), l.memberId || '')}</select></td>
      ${[['kills', 'Kill'], ['deaths', 'Death'], ['assists', 'Assist']].map(([k, n]) => `<td><input type="number" data-f="${k}" min="0" max="999" inputmode="numeric" aria-label="${n}" value="${+l[k] || 0}"></td>`).join('')}
      <td data-rating></td>
      <td><button type="button" class="linkish" data-rm-linha>remover</button></td></tr>`;
    const recalcular = () => document.querySelectorAll('#r-linhas tr').forEach((tr) => {
      const v = (f) => +$(`[data-f=${f}]`, tr).value || 0;
      $('[data-rating]', tr).textContent = rating({ k: v('kills'), d: v('deaths'), a: v('assists') }).toFixed(2);
    });
    const addLinhas = (ls) => { $('#r-linhas').insertAdjacentHTML('beforeend', ls.map(linhaHtml).join('')); recalcular(); };
    const abrir = (date, game) => {
      const rec = D.results.find((r) => r.date === date && r.game === game);
      atual = { date, game, prints: rec?.prints || [] };
      if (rec?.modo) $('#r-modo').value = rec.modo;
      $('#r-editor').innerHTML = `<div class="card">
        <h3>Game ${game} de ${esc(brDate(date))}${rec ? ' (já salvo: editando)' : ''}</h3>
        <div class="field"><label for="r-prints">Prints do placar <span class="hint">(até 4, JPG/PNG/WEBP)</span></label>
          <input id="r-prints" type="file" accept="image/jpeg,image/png,image/webp" multiple></div>
        <p class="hint">As prints ficam guardadas só por 7 dias e depois somem sozinhas. Os números da tabela ficam pra sempre. Dica: tire a print só do placar, sem o resto da tela.</p>
        <div class="previews" id="r-prev"></div>
        ${atual.prints.length ? `<div class="thumbs" id="r-salvas">${atual.prints.map((id, i) => `<a href="${imgUrl(id)}" target="_blank" rel="noopener"><img src="${imgUrl(id)}" alt="Print ${i + 1} do placar"></a>`).join('')}</div>` : ''}
        <div class="actions"><button type="button" data-ler>Ler prints com IA</button></div>
        <div class="status" id="r-st" role="status" aria-live="polite"></div>
        <div class="actions" id="r-repost"></div>
        <div class="table-wrap"><table class="kda-edit">
          <thead><tr><th>Nick lido</th><th>Membro</th><th>Kill</th><th>Death</th><th>Assist</th><th>Rating</th><th><span class="sr-only">Remover</span></th></tr></thead>
          <tbody id="r-linhas"></tbody>
        </table></div>
        <div class="actions"><button type="button" data-add-linha>Adicionar linha</button><button type="button" class="primary" data-salvar>Salvar resultado</button></div>
      </div>`;
      // print que já expirou some da lista em vez de aparecer quebrada
      document.querySelectorAll('#r-salvas img').forEach((img) => img.addEventListener('error', () => img.closest('a').remove()));
      picker = imagePicker($('#r-prints'), $('#r-prev'), 4, $('#r-st'));
      addLinhas(rec?.linhas.length ? rec.linhas : [{}, {}, {}]);
      $('#r-editor h3').scrollIntoView({ block: 'nearest' });
    };
    $('#f-game').onsubmit = (e) => { e.preventDefault(); abrir($('#r-date').value, +$('#r-game').value); };

    T.oninput = (e) => { if (e.target.closest('#r-linhas')) recalcular(); };
    T.onclick = run(async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.abrir) {
        const [d, g] = b.dataset.abrir.split('|');
        $('#r-date').value = d; $('#r-game').value = g;
        return abrir(d, +g);
      }
      if (b.dataset.apagar) {
        const [d, g] = b.dataset.apagar.split('|');
        if (!confirm(`Apagar o game ${g} de ${brDate(d)}? Os números somem do KDA.`)) return;
        await call(`result?date=${d}&game=${g}`, { method: 'DELETE' });
        D.results = await call('results');
        drawLista();
        return msg('Game apagado.');
      }
      if (b.dataset.repost) {
        await call('discord-postar', { method: 'POST', body: { tipo: b.dataset.repost, date: atual.date, game: atual.game } });
        b.remove();
        return msg('Repostado no Discord.');
      }
      if (b.hasAttribute('data-rm-linha')) return b.closest('tr').remove();
      if (b.hasAttribute('data-add-linha')) { addLinhas([{}]); return $('#r-linhas tr:last-child input').focus(); }
      if (b.hasAttribute('data-ler')) {
        const st = $('#r-st');
        b.disabled = true;
        try {
          let ids = [];
          if (picker.get().length) {
            const fd = new FormData();
            picker.get().forEach((x, i) => fd.append('prints', x, `placar${i + 1}.jpg`));
            say(st, 'Enviando as prints…');
            ids = await call('upload-placar', { method: 'POST', body: fd });
            atual.prints = [...atual.prints, ...ids].slice(-4);
            picker.clear();
          } else ids = atual.prints;
          if (!ids.length) return say(st, 'Escolha pelo menos uma print do placar.', true);
          // uma print por pedido: cada leitura leva uns 30s, assim dá pra mostrar o progresso
          const lidas = [];
          for (const [i, id] of ids.entries()) {
            say(st, `Lendo print ${i + 1} de ${ids.length}… (uns 30 segundos cada)`);
            for (const l of await call('ler-placar', { method: 'POST', body: { ids: [id] } })) {
              if (!lidas.some((x) => x.nick.toLowerCase() === l.nick.toLowerCase())) lidas.push(l); // mesma pessoa em 2 prints conta 1 vez
            }
          }
          // tira as linhas vazias e coloca as lidas, já casando cada nick com o membro mais parecido
          document.querySelectorAll('#r-linhas tr').forEach((tr) => { if (!$('[data-f=nick]', tr).value && !$('[data-f=memberId]', tr).value) tr.remove(); });
          addLinhas(lidas.map((l) => ({ ...l, memberId: casarNick(l.nick) })));
          say(st, `${lidas.length} ${lidas.length === 1 ? 'linha lida' : 'linhas lidas'}. Confira o membro de cada linha e os números antes de salvar.`);
        } catch (err) {
          if (err.status === 401) return;
          say(st, err.message, true);
          if (!$('#r-linhas tr')) addLinhas([{}, {}, {}]);
        } finally {
          b.disabled = false;
        }
      }
      if (b.hasAttribute('data-salvar')) {
        const linhas = [...document.querySelectorAll('#r-linhas tr')].map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i.value])))
          .filter((l) => l.memberId);
        const repetido = linhas.find((l, i) => linhas.findIndex((x) => x.memberId === l.memberId) !== i);
        if (repetido) return say($('#r-st'), `${D.members.find((m) => m.id === repetido.memberId)?.nick} está em duas linhas. Deixe só uma.`, true);
        const salvo = await call('result', { method: 'POST', body: { date: atual.date, game: atual.game, modo: $('#r-modo').value.trim(), linhas, prints: atual.prints } });
        D.results = await call('results');
        abrir(atual.date, atual.game);
        drawLista();
        const disc = salvo.discord || {};
        say($('#r-st'), `Resultado salvo: ${linhas.length} ${linhas.length === 1 ? 'jogador' : 'jogadores'}. As linhas marcadas como "Ignorar" não foram salvas. ${DISC_TXT[disc.kdGame] || ''}`);
        // já tinha sido postado: não reposta sozinho, mas o admin pode repostar
        if (admin) $('#r-repost').innerHTML = [['kdGame', 'Repostar KD do game no Discord'], ['kdDia', 'Repostar KD do dia no Discord']]
          .filter(([k]) => disc[k] === 'ja').map(([k, l]) => `<button type="button" data-repost="${k}">${l}</button>`).join('');
      }
    });
  },

  async discord() {
    const T = $('#tab');
    const w = await call('webhook');
    T.innerHTML = `<h1>Discord</h1>
      <p class="lead">Opcional. Com o webhook, cada registro, gear e apply também aparece num canal do Discord. Sem ele, tudo continua no painel.</p>
      <p class="status">${w.configurado ? `Webhook configurado (termina em …${esc(w.final)}).` : 'Nenhum webhook configurado.'}</p>
      <form id="f-wh" class="narrow">
        <div class="field"><label for="wh-url">Link do webhook</label>
          <input type="password" id="wh-url" name="url" required maxlength="300" autocomplete="off" spellcheck="false">
          <span class="hint">No Discord: Editar canal → Integrações → Webhooks → Novo webhook → Copiar URL. Por segurança, o link salvo não aparece de novo aqui.</span></div>
        <div class="actions">
          <button class="primary" type="submit">Salvar webhook</button>
          ${w.configurado ? '<button type="button" data-teste>Enviar teste</button><button type="button" class="danger" data-remover>Remover</button>' : ''}
        </div>
      </form>
      <h2>O que o site posta sozinho</h2>
      <p class="muted">Resultados e presença vão pro webhook de resultados, se o secret DISCORD_RESULTS_WEBHOOK existir; senão, pro de cima. O mesmo game, dia ou post não é postado duas vezes: pra mandar de novo, use "Repostar".</p>
      <form id="f-auto" class="narrow"><fieldset><legend>Postagens automáticas</legend>
        ${AUTOS.map(([k, nome, dica]) => `<label class="check"><input type="checkbox" name="${k}"${D.cfg.discord?.[k] ? ' checked' : ''}> <span>${nome} <span class="hint">${dica}</span></span></label>`).join('')}
      </fieldset><div class="actions"><button class="primary" type="submit">Salvar postagens automáticas</button></div></form>
      <h2>Postar agora</h2>
      <form id="f-manual" class="narrow">
        <div class="field"><label for="dm-tipo">O que postar</label><select id="dm-tipo" name="tipo">${opts([['kdDia', 'KD de um dia'], ['ranking', 'Ranking de KDA da season atual (top 10)'], ['frequencia', 'Frequência da season atual (top 10)'], ['semana', 'Resumo da semana']])}</select></div>
        <div class="field" data-so="kdDia"><label for="dm-date">Dia</label><input type="date" id="dm-date" name="date" value="${hojeLocal()}"></div>
        <div class="field" data-so="ranking" hidden><label for="dm-modo">Modo</label><select id="dm-modo" name="modo"><option value="">Todos</option>${opts([...new Set([...Object.values(D.cfg.modos || {}), ...D.results.map((r) => r.modo)].filter(Boolean))].map((m) => [m, m]))}</select></div>
        <label class="check" data-so="frequencia" hidden><input type="checkbox" name="inativos"> Incluir a lista de inativos</label>
        <div class="actions"><button type="submit">Ver prévia</button><button type="button" class="primary" data-postar disabled>Postar agora</button></div>
        <p class="hint">Primeiro veja a prévia; o botão "Postar agora" libera depois dela.</p>
      </form>
      <div id="dm-previa" aria-live="polite"></div>`;
    $('#f-wh').onsubmit = run(async (e) => {
      e.preventDefault();
      await call('webhook', { method: 'POST', body: { url: e.target.url.value.trim() } });
      await TABS.discord();
      msg('Webhook salvo. Clique em "Enviar teste" pra conferir no Discord.');
    });
    $('#f-auto').onsubmit = run(async (e) => {
      e.preventDefault();
      const f = e.target;
      D.cfg.discord = await call('discord-config', { method: 'POST', body: { discord: Object.fromEntries(AUTOS.map(([k]) => [k, f[k].checked])) } });
      msg('Postagens automáticas salvas.');
    });
    const fm = $('#f-manual');
    const pedido = () => ({ tipo: fm.tipo.value, date: fm.date.value, modo: fm.modo.value, inativos: fm.inativos.checked });
    // mudar qualquer coisa exige ver a prévia de novo
    fm.oninput = () => {
      document.querySelectorAll('#f-manual [data-so]').forEach((el) => (el.hidden = el.dataset.so !== fm.tipo.value));
      $('[data-postar]', fm).disabled = true;
      $('#dm-previa').innerHTML = '';
    };
    fm.onsubmit = run(async (e) => {
      e.preventDefault();
      const embeds = await call('discord-postar', { method: 'POST', body: { ...pedido(), previa: true } });
      $('#dm-previa').innerHTML = `<h3>Prévia${embeds.length > 1 ? ` (${embeds.length} mensagens)` : ''}</h3>` + embeds.map((em) => `<div class="card">
        <strong>${esc(em.title)}</strong>${em.description ? `<p>${esc(em.description)}</p>` : ''}
        <ul>${em.fields.map((f) => `<li><strong>${esc(f.name)}:</strong> ${esc(f.value)}</li>`).join('') || '<li class="muted">Nada pra mostrar nesse período.</li>'}</ul>
      </div>`).join('');
      $('[data-postar]', fm).disabled = false;
    });
    T.onclick = run(async (e) => {
      if (e.target.closest('[data-postar]')) {
        const r = await call('discord-postar', { method: 'POST', body: pedido() });
        $('[data-postar]', fm).disabled = true;
        msg(`Postado no Discord (${r.mensagens} ${r.mensagens === 1 ? 'mensagem' : 'mensagens'}).`);
      }
      if (e.target.closest('[data-teste]')) {
        await call('webhook-teste', { method: 'POST' });
        msg('Teste enviado. Veja se chegou no canal do Discord.');
      }
      if (e.target.closest('[data-remover]') && confirm('Remover o webhook? Os avisos param de ir pro Discord.')) {
        await call('webhook', { method: 'POST', body: { url: '' } });
        await TABS.discord();
        msg('Webhook removido.');
      }
    });
  },

  taticas: () => postsTab('tatica'),
  avisos: () => postsTab('aviso'),

  config() {
    const T = $('#tab');
    const c = D.cfg;
    T.innerHTML = `<h1>Config</h1>
      <form id="f-cfg" class="narrow">
        <div class="field"><label for="c-hor">Horário da guerra</label><input type="text" id="c-hor" name="horario" maxlength="200" value="${esc(c.horario)}">
          <span class="hint">Aparece no registro. Ex.: 21:00 (Brasília). Mude pra 22:00 quando os EUA entrarem no horário de verão.</span></div>
        <div class="field"><label for="c-reg">Regras do clã</label><textarea id="c-reg" name="regras" rows="14" maxlength="20000">${esc(c.regras)}</textarea></div>
        <div class="field"><label for="c-ps">Funções <span class="hint">(uma por linha, no formato: Nome | descrição)</span></label>
          <textarea id="c-ps" name="playstyles" rows="8">${esc(c.playstyles.map((p) => (p.desc ? `${p.nome} | ${p.desc}` : p.nome)).join('\n'))}</textarea>
          <span class="hint">"Não tenho preferência" aparece sempre no registro, não precisa colocar aqui.</span></div>
        <div class="field"><label for="c-gt">Tipos de gear <span class="hint">(um por linha)</span></label>
          <textarea id="c-gt" name="gearTipos" rows="4">${esc((c.gearTipos || []).join('\n'))}</textarea></div>
        <fieldset><legend>Modo de guerra por dia</legend>
          <p class="hint">Na aba Resultados, o modo já vem preenchido pela data. Deixe em branco nos dias sem guerra.</p>
          <div class="modos">${Object.entries(DIAS).map(([d, nome]) => `<div class="field"><label for="c-m-${d}">${nome}</label><input type="text" id="c-m-${d}" name="modo-${d}" maxlength="40" value="${esc(c.modos?.[d] || '')}"></div>`).join('')}</div>
        </fieldset>
        <fieldset><legend>Seasons</legend>
          <p class="hint">Cada season dura mais ou menos 1 mês. Presença, resultados e gear guardam a season da data. Marque qual é a atual.</p>
          <div class="table-wrap"><table>
            <thead><tr><th>Nome</th><th>Início</th><th>Fim</th><th>Atual</th><th><span class="sr-only">Remover</span></th></tr></thead>
            <tbody id="c-seasons">${(c.seasons || []).map((s, i) => seasonRow(s, i, s.id === c.seasonAtual)).join('')}</tbody>
          </table></div>
          <div class="actions"><button type="button" data-add-season>Adicionar season</button></div>
        </fieldset>
        <fieldset><legend>Alerta de inativo</legend>
          <p class="hint">O membro ganha o selo "inativo" na lista com qualquer um dos dois. Vale pra quem está em teste, membro ou veterano.</p>
          <div class="row">
            <div class="field"><label for="c-if">Faltas seguidas</label><input type="number" id="c-if" name="inativoFaltas" min="1" max="50" value="${esc(c.inativoFaltas ?? 3)}"></div>
            <div class="field"><label for="c-id">Dias sem presença</label><input type="number" id="c-id" name="inativoDias" min="1" max="365" value="${esc(c.inativoDias ?? 14)}"></div>
          </div>
        </fieldset>
        <div class="actions"><button class="primary" type="submit">Salvar config</button></div>
      </form>
      <h2>Backup automático</h2>
      <p class="muted">Todo domingo às 03:00 (Brasília) o Worker manda o backup em JSON pro canal privado do Discord configurado no secret DISCORD_BACKUP_WEBHOOK. Sem o secret, nada é enviado.</p>
      <div class="actions"><button type="button" data-backup-teste>Testar backup agora</button></div>
      <h2>Uso do plano grátis</h2>
      <p id="c-uso" class="muted">Carregando…</p>`;
    // contador simples de gravações no KV de hoje (só informativo)
    call('uso').then((x) => {
      $('#c-uso').innerHTML = `Gravações no banco hoje: <strong>${x.hoje}</strong> de ${x.limite} (limite grátis por dia).`
        + (x.hoje > 800 ? ' <span class="low">Perto do limite grátis: evite importar backup ou subir muitas prints hoje.</span>' : '');
    }).catch(() => { $('#c-uso').textContent = 'Não deu pra ler o contador agora.'; });
    let n = (c.seasons || []).length;
    T.onclick = (e) => {
      if (e.target.closest('[data-add-season]')) {
        // nova season começa no dia seguinte ao fim da última e dura 1 mês
        const fims = [...document.querySelectorAll('#c-seasons [data-f=fim]')].map((i) => i.value).filter(Boolean).sort();
        const ini = fims.length ? new Date(new Date(fims.at(-1) + 'T12:00').getTime() + 864e5) : new Date();
        const fim = new Date(ini); fim.setMonth(fim.getMonth() + 1); fim.setDate(fim.getDate() - 1);
        const iso = (d) => d.toISOString().slice(0, 10);
        $('#c-seasons').insertAdjacentHTML('beforeend', seasonRow({ nome: `Season ${n + 1}`, inicio: iso(ini), fim: iso(fim) }, n, !document.querySelector('#c-seasons input[type=radio]')));
        $(`#c-seasons tr:last-child input`).focus();
        n++;
      }
      if (e.target.closest('[data-rm-season]')) e.target.closest('tr').remove();
      if (e.target.closest('[data-backup-teste]')) {
        run(async () => { await call('backup-teste', { method: 'POST' }); msg('Backup enviado pro Discord. Confira o canal privado.'); })();
      }
    };
    $('#f-cfg').onsubmit = run(async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const playstyles = fd.get('playstyles').split('\n').map((l) => {
        const [nome, ...desc] = l.split('|');
        return { nome: nome.trim(), desc: desc.join('|').trim() };
      }).filter((p) => p.nome);
      const rows = [...document.querySelectorAll('#c-seasons tr')];
      const seasons = rows.map((r) => ({ id: r.dataset.id || '', ...Object.fromEntries([...r.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i.value.trim()])) }));
      const atual = rows.find((r) => $('input[type=radio]', r).checked);
      D.cfg = await call('config', { method: 'POST', body: {
        horario: fd.get('horario'), regras: fd.get('regras'), playstyles,
        gearTipos: fd.get('gearTipos').split('\n').map((x) => x.trim()).filter(Boolean),
        modos: Object.fromEntries(Object.keys(DIAS).map((d) => [d, fd.get('modo-' + d).trim()])),
        seasons, seasonAtual: atual?.dataset.id || '', seasonAtualNome: atual && !atual.dataset.id ? $('[data-f=nome]', atual).value.trim() : '',
        inativoFaltas: fd.get('inativoFaltas'), inativoDias: fd.get('inativoDias'),
      } });
      if (!periodo || periodo.tipo === 'season') periodo = periodoPadrao();
      msg('Config salva. O site já mostra os novos valores.');
      TABS.config();
    });
  },

  async equipe() {
    const T = $('#tab');
    const users = await call('users');
    const roles = [['admin', ROLE.admin], ['lider_squad', ROLE.lider_squad]];
    const sqOpts = (sel) => `<option value="">Nenhum</option>${opts(D.squads.map((s) => [s.id, s.nome]), sel)}`;
    T.innerHTML = `<h1>Equipe</h1>
      <h2>Novo usuário</h2>
      <form id="f-user" class="narrow">
        <div class="row">
          <div class="field"><label for="u-name">Usuário <span class="hint">(minúsculas, números, ponto, _ ou -)</span></label><input type="text" id="u-name" name="name" required maxlength="32" autocapitalize="none"></div>
          <div class="field"><label for="u-pass">Senha provisória <span class="hint">(mín. 8)</span></label><input type="text" id="u-pass" name="senha" required minlength="8" maxlength="128" autocomplete="off"></div>
        </div>
        <div class="row">
          <div class="field"><label for="u-role">Cargo</label><select id="u-role" name="role">${opts(roles)}</select></div>
          <div class="field"><label for="u-sq">Squad <span class="hint">(só pra líder)</span></label><select id="u-sq" name="squad">${sqOpts('')}</select></div>
        </div>
        <div class="actions"><button class="primary" type="submit">Criar usuário</button></div>
      </form>
      <h2>Usuários</h2>
      <p class="muted">O superadmin vem dos secrets do Worker e não aparece aqui. Trocar o cargo, resetar a senha ou remover derruba as sessões abertas da pessoa.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Usuário</th><th>Cargo</th><th>Squad</th><th>Senha</th><th>Ações</th></tr></thead>
        <tbody>${users.map((u) => `<tr data-user="${esc(u.name)}">
          <td>${esc(u.name)}</td>
          <td><select aria-label="Cargo de ${esc(u.name)}" data-f="role">${opts(roles, u.role)}</select></td>
          <td><select aria-label="Squad de ${esc(u.name)}" data-f="squad">${sqOpts(u.squad)}</select></td>
          <td>${u.mustChange ? 'Provisória' : 'Definida'}</td>
          <td><div class="actions"><button type="button" data-act="cargo">Salvar cargo</button><button type="button" data-act="reset">Resetar senha</button><button type="button" class="danger" data-act="del">Remover</button></div></td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">Nenhum usuário ainda. Crie sn e ariellor acima.</td></tr>'}</tbody>
      </table></div>`;
    $('#f-user').onsubmit = run(async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await call('user', { method: 'POST', body: { novo: true, name: fd.get('name'), senha: fd.get('senha'), role: fd.get('role'), squad: fd.get('squad') } });
      await TABS.equipe();
      msg(`Usuário ${fd.get('name')} criado. Passe a senha provisória pra ele: no primeiro login ele cria a própria.`);
    });
    T.onclick = run(async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const row = b.closest('tr');
      const name = row.dataset.user;
      if (b.dataset.act === 'cargo') {
        await call('user', { method: 'POST', body: { name, role: $('[data-f=role]', row).value, squad: $('[data-f=squad]', row).value } });
        msg(`Cargo de ${name} salvo.`);
      } else if (b.dataset.act === 'reset') {
        const senha = prompt(`Nova senha provisória pra ${name} (mínimo 8 caracteres):`);
        if (!senha) return;
        await call('user', { method: 'POST', body: { name, senha } });
        msg(`Senha de ${name} resetada. No próximo login ele cria uma nova.`);
      } else {
        if (!confirm(`Remover o usuário ${name}?`)) return;
        await call('user?name=' + encodeURIComponent(name), { method: 'DELETE' });
        msg(`Usuário ${name} removido.`);
      }
      await TABS.equipe();
    });
  },

  async log() {
    const items = await call('log');
    $('#tab').innerHTML = `<h1>Log de ações</h1>
      ${items.length ? `<ul>${items.map((l) => `<li><time datetime="${esc(l.data)}">${new Date(l.data).toLocaleString('pt-BR')}</time>: <strong>${esc(l.quem)}</strong> ${esc(l.texto)}</li>`).join('')}</ul>` : '<p class="muted">Nada registrado ainda.</p>'}
      <p class="muted">Mostra as 300 ações mais recentes. Cada ação fica guardada por 180 dias.</p>`;
  },

  exportar() {
    const T = $('#tab');
    T.innerHTML = `<h1>Exportar</h1>
      <p class="muted">Os CSVs seguem o período escolhido. O backup leva tudo.</p>
      <div id="x-per"></div>
      <div class="actions"><button type="button" class="primary" data-csv>Baixar membros + presença + KDA (CSV)</button><button type="button" data-csv-res>Baixar resultados por game (CSV)</button><button type="button" data-bk>Baixar backup completo (JSON)</button></div>
      <h2>Importar backup</h2>
      <p class="muted">Sobrescreve os itens que tiverem a mesma chave. Usuários do painel e imagens não entram no backup.</p>
      <form id="f-imp" class="narrow">
        <div class="field"><label for="imp-file">Arquivo de backup (.json)</label><input id="imp-file" type="file" accept="application/json,.json" required></div>
        <div class="actions"><button type="submit">Importar backup</button></div>
      </form>`;
    T.onclick = run(async (e) => {
      if (e.target.closest('[data-csv]')) download('membros-presenca-kda.csv', csv(), 'text/csv;charset=utf-8');
      if (e.target.closest('[data-csv-res]')) download('resultados.csv', csvResultados(), 'text/csv;charset=utf-8');
      if (e.target.closest('[data-bk]')) download(`backup-cla-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await call('backup'), null, 1), 'application/json');
    });
    $('#f-imp').onsubmit = run(async (e) => {
      e.preventDefault();
      let data;
      try { data = JSON.parse(await $('#imp-file').files[0].text()); } catch { return msg('Esse arquivo não é um JSON válido.', true); }
      if (!confirm(`Importar ${Object.keys(data).length} itens?`)) return;
      const r = await call('backup', { method: 'POST', body: data });
      await reload();
      msg(`Backup importado: ${r.itens} itens.`);
    });
    montarPeriodo($('#x-per'), 'xp', () => {});
  },
};

function ficha(id) {
  const m = D.members.find((x) => x.id === id);
  const admin = isAdmin();
  const hist = D.att.filter((a) => a.marks[id] && noPeriodo(a.date, a.season)).sort((a, b) => b.date.localeCompare(a.date));
  const gears = m.gear.map((g, idx) => ({ ...g, idx })).filter((g) => noPeriodo(g.data.slice(0, 10), g.season)).reverse();
  const k = kda(id);
  const jogos = D.results.filter((r) => noPeriodo(r.date, r.season) && r.linhas.some((l) => l.memberId === id))
    .sort((a, b) => b.date.localeCompare(a.date) || b.game - a.game);
  const row = (k, v) => (v ? `<tr><th scope="row">${k}</th><td class="pre">${esc(v)}</td></tr>` : '');
  dlg(`<h2 id="dlg-title">${esc(m.nick)}</h2>
    <p class="meta">Registrado em ${fmtDate(m.criadoEm)}. Status: ${STATUS[m.status] || esc(m.status)}. </p>
    ${m.motivoRecusa && m.status === 'recusado' ? `<p class="status bad">Motivo da recusa (o membro vê): ${esc(m.motivoRecusa)}</p>` : ''}
    ${admin && !m.candidato ? `<div class="actions">${['teste', 'membro', 'veterano'].includes(m.status) ? '<button type="button" data-suspender>Tirar acesso</button>' : '<button type="button" class="primary" data-aprovar-m>Aprovar</button>'}${m.status === 'pendente' ? '<button type="button" data-desaprovar>Desaprovar</button>' : ''}</div>` : ''}
    ${admin && !m.candidato ? '<div class="actions"><button type="button" data-reg>Editar registro</button><button type="button" data-acesso>Gerar link de acesso</button><button type="button" class="danger" data-apagar-membro>Apagar membro</button></div>' : ''}
    <div id="fi-per"></div>
    <p>Frequência no período: ${fmtFreq(freq(id))}</p>
    <h3>KDA no período</h3>
    ${k.jogos ? `<p><strong>${esc(fmtKda(k))}</strong> <span class="muted">em ${k.jogos} ${k.jogos === 1 ? 'game' : 'games'}</span></p>
      <ul>${jogos.map((r) => { const l = r.linhas.find((x) => x.memberId === id); return `<li>${esc(brDate(r.date))}, game ${esc(r.game)}${r.modo ? ` (${esc(r.modo)})` : ''}: ${esc(fmtKda({ k: l.kills, d: l.deaths, a: l.assists }))}</li>`; }).join('')}</ul>`
      : '<p class="muted">Nenhum game no período.</p>'}
    <table>
      ${row('Tipo de gear', (m.gearTipos || []).join(', '))}
      ${row('Discord', m.discord)}${row('Idade', m.idade)}${row('País', m.pais)}${row('Fuso', m.fuso)}
      ${row('Dias', m.dias.map((d) => DIAS[d]).join(', '))}
      ${row('Função', [...m.playstyles, m.playstyleOutro].filter(Boolean).join(', '))}
      ${row('Squad desejado', sqName(m.squadDesejado))}${m.squad ? row('Vaga no squad', m.vaga === 'reserva' ? 'Reserva' : 'Fixo') : ''}
      ${row('Já foi de clã', m.cla === 'sim' ? `Sim. ${m.claQual || ''}` : m.cla ? 'Não' : '')}
      ${row('Já jogou FPS', m.fps === 'sim' ? `Sim. ${m.fpsQual || ''}` : 'Não')}
      ${row('Microfone', m.mic === 'sim' ? 'Sim' : 'Não')}${row('Sobre', m.sobre)}
    </table>
    <h3>Histórico de gear no período</h3>
    ${gears.length ? gears.map((g) => `<div class="card">
      <p class="meta">${fmtDate(g.data)}${nomeSeason(g.season || seasonDaData(g.data.slice(0, 10))) ? `, ${esc(nomeSeason(g.season || seasonDaData(g.data.slice(0, 10))))}` : ''}</p>
      ${g.tipos?.length ? `<p><span class="pill">${g.tipos.map(esc).join('</span> <span class="pill">')}</span></p>` : ''}
      ${g.texto ? `<p class="pre">${esc(g.texto)}</p>` : ''}
      <div class="thumbs">${g.imgs.map((i, n) => `<a href="${imgUrl(i)}" target="_blank" rel="noopener"><img src="${imgUrl(i)}" alt="Print ${n + 1} do gear de ${fmtDate(g.data)}" loading="lazy"></a>`).join('')}</div>
      ${g.expira && g.imgs.length ? `<p class="hint">As prints deste gear somem em ${fmtDate(g.expira)} (só as da última atualização ficam sem prazo).</p>` : ''}
      ${admin ? `<div class="actions"><button type="button" data-gear-edit="${g.idx}">Editar</button><button type="button" class="danger" data-gear-del="${g.idx}">Apagar</button></div>` : ''}
    </div>`).join('') : '<p class="muted">Nenhum gear no período.</p>'}
    <h3>Histórico de presença no período</h3>
    ${hist.length ? `<ul>${hist.map((a) => {
      const mk = a.marks[id];
      return `<li>${esc(brDate(a.date))}: ${ATT[mk.s] || 'Sem marcação'}${mk.j ? ` (${esc(mk.j)})` : ''}
        ${mk.o?.length ? `<ul>${mk.o.map((o) => `<li>${GUERRA[o.g] || GUERRA['']}: ${esc(o.t)}</li>`).join('')}</ul>` : ''}</li>`;
    }).join('')}</ul>` : '<p class="muted">Nenhuma guerra marcada.</p>'}
    ${m.candidato ? `<p class="status">Candidato ao seu squad. Aceite ou recuse o pedido na aba Squads; a avaliação fica liberada depois que ele entrar.</p>
    <div class="actions"><button type="button" data-close>Fechar</button></div>` : `<h3>Avaliação</h3>
    <form id="f-ficha">
      ${admin ? `<div class="row">
        <div class="field"><label for="fi-st">Status</label><select id="fi-st" name="status">${opts(Object.entries(STATUS), m.status)}</select></div>
        <div class="field"><label for="fi-sq">Squad atual</label><select id="fi-sq" name="squad"><option value="">Nenhum</option>${opts(D.squads.map((s) => [s.id, s.nome]), m.squad)}</select></div>
      </div>` : ''}
      <div class="field"><label for="fi-nota">Nota <span class="hint">(1 a 10)</span></label><input id="fi-nota" name="nota" type="number" min="1" max="10" step="1" value="${esc(m.nota)}"></div>
      <fieldset><legend>Tags</legend>
        <p class="hint">🔒 = oculta: só a equipe vê. As outras aparecem no perfil do membro.</p>
        <div class="options">${[...new Set([...D.tags.map((t) => t.nome), ...m.tags])].map((t) => `<label class="check"><input type="checkbox" name="tags" value="${esc(t)}"${m.tags.includes(t) ? ' checked' : ''}> ${esc(tagTxt(t))}</label>`).join('')}</div>
        <div class="field"><label for="fi-nova">Criar tag nova</label><input id="fi-nova" name="novaTag" type="text" maxlength="30"></div>
        ${admin ? '<label class="check"><input type="checkbox" name="novaVisivel"> A tag nova é visível pros membros</label>' : '<p class="hint">Tag nova criada aqui começa oculta.</p>'}
      </fieldset>
      <div class="field"><label for="fi-notas">Anotações</label><textarea id="fi-notas" name="anotacoes" maxlength="3000">${esc(m.anotacoes)}</textarea></div>
      <div class="status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="primary" type="submit">Salvar ficha</button><button type="button" data-close>Fechar</button></div>
    </form>`}`);
  montarPeriodo($('#fi-per'), 'fp', () => { ficha(id); $('#fp-t')?.focus(); });
  // prints de gear antigas somem em 60 dias: no lugar da imagem quebrada, um aviso
  document.querySelectorAll('#dlg .thumbs img').forEach((img) => img.addEventListener('error', () => {
    const aviso = document.createElement('span');
    aviso.className = 'pill';
    aviso.textContent = 'print expirada';
    img.closest('a').replaceWith(aviso);
  }));
  // edições do admin: registro e itens de gear (o Worker confere o cargo)
  $('#dlg').onclick = run(async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-reg')) return registroForm(m);
    // link que devolve o acesso do membro (outro aparelho, navegador limpo, membro antigo); os acessos antigos param de valer
    if (b.hasAttribute('data-acesso')) {
      if (!confirm(`Gerar um link de acesso pra ${m.nick}? Os acessos que ele já tinha em outros aparelhos param de valer.`)) return;
      const r = await call('member-acesso', { method: 'POST', body: { id } });
      prompt(`Link de acesso de ${m.nick}. Mande só pra ele, no privado: quem tiver o link entra como ele.`, new URL(`index.html#acesso/${r.token}`, location.href).href);
      return msg(`Link de acesso gerado pra ${m.nick}.`);
    }
    // aprovar / desaprovar (com motivo que o membro vê) / tirar acesso sem apagar
    if (b.hasAttribute('data-aprovar-m') || b.hasAttribute('data-desaprovar')) {
      const aprovar = b.hasAttribute('data-aprovar-m');
      const motivo = aprovar ? '' : prompt(`Desaprovar ${m.nick}? Motivo (opcional, aparece pra ele):`, '');
      if (motivo === null) return;
      Object.assign(m, await call('approve', { method: 'POST', body: { id, aprovar, motivo } }));
      await reload(); msg(`${m.nick} ${aprovar ? 'aprovado' : 'desaprovado'}.`); return ficha(id);
    }
    if (b.hasAttribute('data-suspender')) {
      if (!confirm(`Tirar o acesso de ${m.nick}? Ele continua na lista, mas não vê táticas, avisos nem perfis. Dá pra aprovar de novo depois.`)) return;
      Object.assign(m, await call('member', { method: 'POST', body: { id, status: 'suspenso' } }));
      await reload(); msg(`${m.nick} ficou sem acesso.`); return ficha(id);
    }
    if (b.hasAttribute('data-apagar-membro')) {
      if (!confirm(`Apagar ${m.nick} de vez?\n\nSome o registro, a ficha e as prints de gear. Não dá pra desfazer.\nA presença e os resultados antigos ficam no histórico com o nick.\n\nSe a pessoa só saiu do clã, prefira o status "Removido".`)) return;
      await call('member?id=' + id, { method: 'DELETE' });
      D.members = D.members.filter((x) => x.id !== id);
      D.squads = await call('squads');
      $('#dlg').close();
      redraw();
      return msg(`${m.nick} foi apagado.`);
    }
    const salvarGear = async (gearEdit, texto) => {
      Object.assign(m, await call('member', { method: 'POST', body: { id, gearEdit } }));
      ficha(id);
      msg(texto);
    };
    if (b.dataset.gearDel !== undefined && confirm('Apagar esse gear e as prints dele?')) await salvarGear({ idx: +b.dataset.gearDel, remover: true }, 'Gear apagado.');
    if (b.dataset.gearEdit !== undefined) gearForm(m, +b.dataset.gearEdit, salvarGear);
  });
  if (m.candidato) return;
  $('#f-ficha').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { id, nota: fd.get('nota'), anotacoes: fd.get('anotacoes'), tags: [...fd.getAll('tags'), fd.get('novaTag')].filter(Boolean) };
    if (admin && fd.get('novaTag') && fd.get('novaVisivel')) await call('tag', { method: 'POST', body: { nome: fd.get('novaTag'), visivel: true } }).catch(() => {});
    if (admin) Object.assign(body, { status: fd.get('status'), squad: fd.get('squad') });
    try {
      Object.assign(m, await call('member', { method: 'POST', body }));
      D.tags = await call('tags');
      if (admin) D.squads = await call('squads');
      $('#dlg').close();
      msg(`Ficha de ${m.nick} salva.`);
      redraw();
    } catch (err) {
      if (err.status !== 401) say($('#f-ficha .status'), err.message, true);
    }
  };
}

// Edição de um item de gear: abre um bloco no fim da ficha (o diálogo é um só).
function gearForm(m, idx, salvar) {
  const g = m.gear[idx];
  const tipos = [...new Set([...(D.cfg.gearTipos || []), ...(g.tipos || [])])];
  $('#dlg').insertAdjacentHTML('beforeend', `<form id="f-gear-ed" class="card">
    <h3>Editar gear de ${fmtDate(g.data)}</h3>
    <fieldset><legend>Tipo de gear</legend><div class="options">${tipos.map((t) => `<label class="check"><input type="checkbox" name="tipo" value="${esc(t)}"${g.tipos?.includes(t) ? ' checked' : ''}> ${esc(t)}</label>`).join('')}</div></fieldset>
    <div class="field"><label for="ge-t">Texto</label><textarea id="ge-t" name="texto" maxlength="1000">${esc(g.texto)}</textarea></div>
    <div class="actions"><button class="primary" type="submit">Salvar gear</button></div>
  </form>`);
  const f = $('#f-gear-ed');
  f.scrollIntoView();
  $('input, textarea', f).focus();
  f.onsubmit = run(async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    await salvar({ idx, texto: fd.get('texto'), tipos: fd.getAll('tipo') }, 'Gear salvo.');
  });
}

// Edição dos dados do registro (só admin).
function registroForm(m) {
  const sim = (v, nome, id) => `<div class="options" role="radiogroup" aria-labelledby="${id}">
    <label class="check"><input type="radio" name="${nome}" value="sim"${v === 'sim' ? ' checked' : ''}> Sim</label>
    <label class="check"><input type="radio" name="${nome}" value="nao"${v !== 'sim' ? ' checked' : ''}> Não</label></div>`;
  const checks = (nome, todos, marcados) => `<div class="options">${[...new Set([...todos, ...marcados])].map((x) => `<label class="check"><input type="checkbox" name="${nome}" value="${esc(x)}"${marcados.includes(x) ? ' checked' : ''}> ${esc(DIAS[x] || x)}</label>`).join('')}</div>`;
  const txt = (nome, label, v, max) => `<div class="field"><label for="re-${nome}">${label}</label><input type="text" id="re-${nome}" name="${nome}" maxlength="${max}" value="${esc(v)}"></div>`;
  dlg(`<h2 id="dlg-title">Editar registro de ${esc(m.nick)}</h2>
    <form id="f-reg">
      <div class="row">${txt('nick', 'Nick', m.nick, 32)}${txt('discord', 'Discord', m.discord, 40)}</div>
      <div class="row">${txt('idade', 'Idade', m.idade, 3)}${txt('pais', 'País', m.pais, 60)}${txt('fuso', 'Fuso (ex.: GMT-3)', m.fuso || 'GMT-3', 9)}</div>
      <fieldset><legend>Dias que pode jogar</legend>${checks('dias', Object.keys(DIAS), m.dias)}</fieldset>
      <fieldset><legend>Funções</legend>${checks('playstyles', D.cfg.playstyles.map((p) => p.nome).concat('Não tenho preferência'), m.playstyles)}</fieldset>
      ${txt('playstyleOutro', 'Outra função ou detalhe', m.playstyleOutro, 100)}
      <fieldset><legend>Tipo de gear</legend>${checks('gearTipos', D.cfg.gearTipos || [], m.gearTipos || [])}</fieldset>
      <div class="field"><span id="re-cla-q">Já foi de clã no Stalzone?</span>${sim(m.cla, 'cla', 're-cla-q')}</div>
      ${txt('claQual', 'Quais clãs e por quanto tempo', m.claQual, 200)}
      <div class="field"><span id="re-fps-q">Já jogou outro FPS?</span>${sim(m.fps, 'fps', 're-fps-q')}</div>
      ${txt('fpsQual', 'Quais FPS, rank e tempo', m.fpsQual, 200)}
      <div class="field"><span id="re-mic-q">Microfone?</span>${sim(m.mic, 'mic', 're-mic-q')}</div>
      <div class="field"><label for="re-sobre">Sobre</label><textarea id="re-sobre" name="sobre" maxlength="1000">${esc(m.sobre)}</textarea></div>
      <div class="status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="primary" type="submit">Salvar registro</button><button type="button" data-voltar>Voltar pra ficha</button></div>
    </form>`);
  $('[data-voltar]').onclick = () => ficha(m.id);
  $('#f-reg').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const dados = Object.fromEntries(['nick', 'discord', 'idade', 'pais', 'fuso', 'playstyleOutro', 'cla', 'claQual', 'fps', 'fpsQual', 'mic', 'sobre'].map((k) => [k, (fd.get(k) || '').trim()]));
    Object.assign(dados, { dias: fd.getAll('dias'), playstyles: fd.getAll('playstyles'), gearTipos: fd.getAll('gearTipos') });
    try {
      Object.assign(m, await call('member', { method: 'POST', body: { id: m.id, dados } }));
      if (isAdmin()) D.squads = await call('squads');
      ficha(m.id);
      msg(`Registro de ${m.nick} salvo.`);
      redraw();
    } catch (err) {
      if (err.status !== 401) say($('#f-reg .status'), err.message, true);
    }
  };
}

function squadForm(s ={ nome: '', estilo: '', lider: '', fixos: [] }) {
  dlg(`<h2 id="dlg-title">${s.id ? 'Editar squad' : 'Novo squad'}</h2>
    <form id="f-sq">
      <div class="field"><label for="sq-nome">Nome</label><input type="text" id="sq-nome" name="nome" required maxlength="40" value="${esc(s.nome)}"></div>
      <div class="field"><label for="sq-estilo">Como o squad joga <span class="hint">(descrição curta)</span></label><input type="text" id="sq-estilo" name="estilo" maxlength="100" value="${esc(s.estilo)}"></div>
      ${procuraHtml(s)}
      <div class="field"><label for="sq-lider">Líder (nick)</label><input type="text" id="sq-lider" name="lider" maxlength="40" value="${esc(s.lider)}">
        <span class="hint">Pro líder entrar no painel, o superadmin cria o usuário dele na aba Equipe com o cargo "Líder de squad".</span></div>
      <fieldset><legend>Membros do squad</legend><div class="options">
        ${active().map((m) => `<label class="check"><input type="checkbox" name="fixos" value="${esc(m.id)}"${s.id && m.squad === s.id ? ' checked' : ''}> ${esc(m.nick)}${m.squad && m.squad !== s.id ? ` <span class="muted">(${esc(sqName(m.squad))})</span>` : ''}</label>`).join('') || '<p class="muted">Nenhum membro ativo.</p>'}
      </div></fieldset>
      <div class="status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="primary" type="submit">Salvar squad</button><button type="button" data-close>Cancelar</button></div>
    </form>`);
  $('#f-sq').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await call('squad', { method: 'POST', body: { id: s.id, nome: fd.get('nome'), estilo: fd.get('estilo'), lider: fd.get('lider'), funcoes: fd.getAll('funcoes'), builds: lerBuilds(fd), fixos: fd.getAll('fixos') } });
      await reload();
      $('#dlg').close();
      await TABS.squads();
      msg(`Squad ${fd.get('nome')} salvo.`);
    } catch (err) {
      if (err.status !== 401) say($('#f-sq .status'), err.message, true);
    }
  };
}

// ---------- casar o nick lido na print com o membro mais parecido ----------
const normNick = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
function parecido(a, b) {
  a = normNick(a); b = normNick(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9; // ex.: "[MIBR]Fulano" e "Fulano"
  // distância de edição (Levenshtein) virada em nota de 0 a 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
// abaixo de 0.6 é melhor deixar "Ignorar" e o admin escolher
function casarNick(nick) {
  let melhor = '', nota = 0;
  for (const m of active()) { const p = parecido(nick, m.nick); if (p > nota) { nota = p; melhor = m.id; } }
  return nota >= 0.6 ? melhor : '';
}

// criar tag e marcar se é visível pros membros (só admin; o Worker confere)
async function tagsForm() {
  dlg(`<h2 id="dlg-title">Tags</h2>
    <p class="hint">Visível = aparece no perfil do membro pra todo o clã. Oculta (🔒) = só a equipe vê. Tag nova começa oculta.</p>
    <form id="f-tags">
      <ul class="vagas">${D.tags.map((t, i) => `<li><label class="check"><input type="checkbox" name="v-${i}" data-nome="${esc(t.nome)}"${t.visivel ? ' checked' : ''}> ${esc(t.nome)}</label><span class="muted">${t.visivel ? 'visível' : '🔒 oculta'}</span></li>`).join('')}</ul>
      <div class="field"><label for="tg-nova">Nova tag</label><input type="text" id="tg-nova" maxlength="30"></div>
      <label class="check"><input type="checkbox" id="tg-vis"> Visível pros membros</label>
      <div class="status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="primary" type="submit">Salvar tags</button><button type="button" data-close>Fechar</button></div>
    </form>`);
  $('#f-tags').onsubmit = async (e) => {
    e.preventDefault();
    try {
      for (const c of document.querySelectorAll('#f-tags [data-nome]')) {
        const t = D.tags.find((x) => x.nome === c.dataset.nome);
        if (t && t.visivel !== c.checked) await call('tag', { method: 'POST', body: { nome: t.nome, visivel: c.checked } });
      }
      if ($('#tg-nova').value.trim()) await call('tag', { method: 'POST', body: { nome: $('#tg-nova').value.trim(), visivel: $('#tg-vis').checked } });
      D.tags = await call('tags');
      $('#dlg').close();
      redraw();
      msg('Tags salvas.');
    } catch (err) {
      if (err.status !== 401) say($('#f-tags .status'), err.message, true);
    }
  };
}

// interruptores das postagens automáticas no Discord: [chave, nome, dica]
const AUTOS = [
  ['registro', 'Novo registro', '(com as prints do gear)'],
  ['gear', 'Atualização de gear', ''],
  ['apply', 'Novo apply em squad', ''],
  ['kdGame', 'KD do game', '(ao salvar um game em Resultados)'],
  ['kdDia', 'KD do dia', '(ao salvar o Game 3, o último do dia)'],
  ['presenca', 'Presença do dia', '(só os nomes; a justificativa não vai)'],
  ['tatica', 'Nova tática', '(título + link)'],
  ['aceito', 'Membro aceito', '(ao aprovar um registro: "X foi aceito no clã")'],
];
// resposta do Worker sobre o que foi pro Discord ao salvar
const DISC_TXT = { postado: 'Postado no Discord.', erro: 'Não deu pra postar no Discord (confira o webhook).' };

// linha editável de season na Config
const seasonRow = (s, i, atual) => `<tr data-id="${esc(s.id || '')}">
  <td><label class="sr-only" for="cs-n-${i}">Nome da season</label><input type="text" id="cs-n-${i}" data-f="nome" required maxlength="40" value="${esc(s.nome)}"></td>
  <td><label class="sr-only" for="cs-i-${i}">Início</label><input type="date" id="cs-i-${i}" data-f="inicio" required value="${esc(s.inicio)}"></td>
  <td><label class="sr-only" for="cs-f-${i}">Fim</label><input type="date" id="cs-f-${i}" data-f="fim" required value="${esc(s.fim)}"></td>
  <td><label class="check"><input type="radio" name="season-atual"${atual ? ' checked' : ''}> <span class="sr-only">Season atual: ${esc(s.nome)}</span></label></td>
  <td><button type="button" class="linkish" data-rm-season>remover</button></td>
</tr>`;

// ---------- o que o squad procura: funções + builds (tipo de gear e quantidade opcional) ----------
const fmtBuilds = (bs) => bs.map((b) => (b.qtd ? `${b.qtd} ${b.tipo}` : b.tipo)).join(', ');
const lerBuilds = (fd) => fd.getAll('build').map((tipo) => ({ tipo, qtd: +fd.get('qtd-' + tipo) || null }));
function procuraHtml(s) {
  const funcoes = [...new Set([...D.cfg.playstyles.map((p) => p.nome), ...(s.funcoes || [])])];
  const tipos = [...new Set([...(D.cfg.gearTipos || []), ...(s.builds || []).map((b) => b.tipo)])];
  return `<fieldset><legend>Funções que o squad procura</legend>
      <p class="hint">O registro recomenda este squad pra quem marcar alguma delas.</p>
      <div class="options">${funcoes.map((f) => `<label class="check"><input type="checkbox" name="funcoes" value="${esc(f)}"${s.funcoes?.includes(f) ? ' checked' : ''}> ${esc(f)}</label>`).join('')}</div>
    </fieldset>
    <fieldset><legend>Builds que o squad procura</legend>
      <p class="hint">Marque os tipos de gear. A quantidade é opcional (ex.: 2 Tank).</p>
      <div class="builds">${tipos.map((tipo, i) => {
        const b = (s.builds || []).find((x) => x.tipo === tipo);
        return `<div class="build"><label class="check"><input type="checkbox" name="build" value="${esc(tipo)}"${b ? ' checked' : ''}> ${esc(tipo)}</label>
          <label class="sr-only" for="bq-${i}">Quantos ${esc(tipo)}</label>
          <input type="number" id="bq-${i}" name="qtd-${esc(tipo)}" min="1" max="20" placeholder="Qtd." value="${esc(b?.qtd ?? '')}"></div>`;
      }).join('')}</div>
    </fieldset>`;
}
// admin ou líder do próprio squad (o Worker confere de novo)
function procuraForm(s) {
  dlg(`<h2 id="dlg-title">O que o ${esc(s.nome)} procura</h2>
    <form id="f-procura">${procuraHtml(s)}
      <div class="status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="primary" type="submit">Salvar</button><button type="button" data-close>Cancelar</button></div>
    </form>`);
  $('#f-procura').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await call('squad-procura', { method: 'POST', body: { id: s.id, funcoes: fd.getAll('funcoes'), builds: lerBuilds(fd) } });
      D.squads = await call('squads');
      $('#dlg').close();
      await TABS.squads();
      msg(`O que o ${s.nome} procura foi salvo. Já aparece no site.`);
    } catch (err) {
      if (err.status !== 401) say($('#f-procura .status'), err.message, true);
    }
  };
}

// Avisos e táticas: mesma lista e mesmo editor, só muda o tipo.
const NOME_TIPO = { tatica: ['Táticas', 'tática'], aviso: ['Avisos', 'aviso'] };
async function postsTab(tipo) {
  const T = $('#tab');
  const [titulo, um] = NOME_TIPO[tipo];
  const posts = (await call('posts')).filter((p) => (p.tipo || 'tatica') === tipo);
  T.innerHTML = `<h1>${titulo}</h1>
    <div class="actions"><button type="button" class="primary" data-novo>Novo ${um === 'aviso' ? 'aviso' : 'post de tática'}</button></div>
    ${posts.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Título</th><th>Data</th><th>Quem vê</th><th>Ações</th></tr></thead>
      <tbody>${posts.map((p) => `<tr><td>${esc(p.titulo)}</td><td>${fmtDate(p.data)}</td><td>${p.publico === false ? 'Só admins (antigo)' : 'Membros'}</td>
        <td><div class="actions"><button type="button" data-edit="${esc(p.id)}">Editar</button><button type="button" class="danger" data-del="${esc(p.id)}">Apagar</button></div></td></tr>`).join('')}</tbody>
    </table></div>` : `<p class="muted">Nada publicado em ${titulo.toLowerCase()} ainda.</p>`}`;
  T.onclick = run(async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-novo')) return postForm(tipo);
    if (b.dataset.edit) return postForm(tipo, posts.find((p) => p.id === b.dataset.edit));
    if (b.dataset.del) {
      const p = posts.find((x) => x.id === b.dataset.del);
      if (!confirm(`Apagar "${p.titulo}" e as imagens?`)) return;
      await call('post?id=' + p.id, { method: 'DELETE' });
      await postsTab(tipo);
      msg('Apagado.');
    }
  });
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// CSV pro Excel em português (separador ;), com uma coluna por data de guerra.
function csv() {
  const dates = D.att.filter((a) => noPeriodo(a.date, a.season)).map((a) => a.date).sort();
  const head = ['Nick', 'Discord', 'Idade', 'País', 'Fuso', 'Dias', 'Funções', 'Tipo de gear', 'Squad desejado', 'Squad atual', 'Status', 'Nota', 'Tags',
    'Microfone', 'Já foi de clã', 'Quais clãs', 'Já jogou FPS', 'Quais FPS', 'Registro', 'Presenças', 'Faltas', 'Justificadas', 'Frequência %',
    'Games', 'Kill', 'Death', 'Assist', 'Rating', ...dates.map(brDate)];
  const sn = (v) => ({ sim: 'Sim', nao: 'Não' })[v] || '';
  const rows = D.members.filter((m) => !m.candidato).map((m) => {
    const f = freq(m.id);
    const k = kda(m.id);
    const porData = dates.map((d) => {
      const mk = D.att.find((a) => a.date === d).marks[m.id];
      return mk ? ATT[mk.s] + (mk.j ? `: ${mk.j}` : '') : '';
    });
    return [m.nick, m.discord, m.idade, m.pais, m.fuso, m.dias.map((d) => DIAS[d]).join(' '), [...m.playstyles, m.playstyleOutro].filter(Boolean).join(', '),
      (m.gearTipos || []).join(', '), sqName(m.squadDesejado), sqName(m.squad), STATUS[m.status], m.nota ?? '', m.tags.join(', '), sn(m.mic), sn(m.cla), m.claQual, sn(m.fps), m.fpsQual,
      fmtDate(m.criadoEm), f.presente, f.faltou, f.justificou, f.pct ?? '',
      k.jogos, k.k, k.d, k.a, k.jogos ? rating(k).toFixed(2).replace('.', ',') : '', ...porData];
  });
  return toCsv(head, rows);
}

// Uma linha por jogador por game, no período.
function csvResultados() {
  const rows = D.results.filter((r) => noPeriodo(r.date, r.season)).sort((a, b) => a.date.localeCompare(b.date) || a.game - b.game)
    .flatMap((r) => r.linhas.map((l) => [brDate(r.date), r.game, r.modo, nomeSeason(r.season || seasonDaData(r.date)), l.nick,
      l.kills, l.deaths, l.assists, rating({ k: l.kills, d: l.deaths, a: l.assists }).toFixed(2).replace('.', ',')]));
  return toCsv(['Data', 'Game', 'Modo', 'Season', 'Nick', 'Kill', 'Death', 'Assist', 'Rating'], rows);
}

function toCsv(head, rows) {
  // célula começando com = + - @ vira fórmula no Excel: o apóstrofo neutraliza (um @nome simples do Discord é seguro)
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s) && !/^@[\w.]+$/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
}

function postForm(tipo, p = { titulo: '', texto: '', imgs: [], publico: true }) {
  const keep = [...p.imgs];
  dlg(`<h2 id="dlg-title">${p.id ? 'Editar' : 'Novo'} ${tipo === 'aviso' ? 'aviso' : 'post de tática'}</h2>
    <form id="f-post">
      <div class="field"><label for="po-t">Título</label><input type="text" id="po-t" name="titulo" required maxlength="120" value="${esc(p.titulo)}"></div>
      <div class="field"><label for="po-x">Texto</label><textarea id="po-x" name="texto" rows="10" maxlength="20000">${esc(p.texto)}</textarea></div>
      <p class="hint">Aparece no site só pra membros aprovados (quem entra com nick e senha).</p>
      ${p.id ? '<div class="field"><span>Imagens do post</span><div class="previews" id="po-keep"></div></div>' : ''}
      <div class="field"><label for="po-f">Adicionar imagens <span class="hint">(até 8 por post, JPG/PNG/WEBP)</span></label><input id="po-f" type="file" accept="image/jpeg,image/png,image/webp" multiple></div>
      <div class="previews" id="po-new"></div>
      <div class="status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="primary" type="submit">Salvar post</button><button type="button" data-close>Cancelar</button></div>
    </form>`);
  const st = $('#f-post .status');
  const drawKeep = () => {
    if (!p.id) return;
    $('#po-keep').innerHTML = keep.map((id, i) => `<figure><img src="${imgUrl(id)}" alt="Imagem ${i + 1} do post"><button type="button" data-rm="${i}" aria-label="Remover imagem ${i + 1}">×</button></figure>`).join('');
  };
  drawKeep();
  $('#f-post').onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { keep.splice(+rm.dataset.rm, 1); drawKeep(); $('#po-f').focus(); }
  };
  const MAX_IMGS_POST = 8; // igual ao Worker
  const picker = imagePicker($('#po-f'), $('#po-new'), Math.max(0, MAX_IMGS_POST - keep.length), st);
  $('#f-post').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = $('[type=submit]', f);
    if (keep.length + picker.get().length > MAX_IMGS_POST) return say(st, `Cada post pode ter no máximo ${MAX_IMGS_POST} imagens. Remova algumas.`, true);
    btn.disabled = true;
    say(st, 'Salvando…');
    try {
      let ids = [];
      if (picker.get().length) {
        const fd = new FormData();
        picker.get().forEach((b, i) => fd.append('prints', b, `img${i + 1}.jpg`));
        ids = await call('upload', { method: 'POST', body: fd });
      }
      await call('post', { method: 'POST', body: { id: p.id, titulo: f.titulo.value, texto: f.texto.value, publico: true, tipo, imgs: [...keep, ...ids] } });
      picker.clear();
      $('#dlg').close();
      await postsTab(tipo);
      msg('Salvo.');
    } catch (err) {
      if (err.status !== 401) say(st, err.message, true);
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- início ----------
(async () => {
  if (!sess) return view('login');
  try {
    saveSess({ ...sess, ...(await call('me')) });
    start();
  } catch (e) {
    if (e.status !== 401) { view('login'); say($('#f-login .status'), e.message, true); }
  }
})();
