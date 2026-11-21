// Painel admin. O Worker confere o cargo em TODA rota; aqui a gente só esconde o que o cargo não usa.
const $ = (s, el = document) => el.querySelector(s);
const STATUS = { teste: 'Em teste', membro: 'Membro', veterano: 'Veterano', removido: 'Removido' };
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
const active = () => D.members.filter((m) => m.status !== 'removido' && !m.candidato).sort((a, b) => a.nick.localeCompare(b.nick));
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
  d.showModal();
  d.scrollTop = 0;
}

// mes: 'AAAA-MM' pra contar só aquele mês; vazio = tudo
function freq(id, mes = '') {
  const c = { presente: 0, faltou: 0, justificou: 0, ocorrencias: 0 };
  for (const a of D.att) {
    const mk = a.marks[id];
    if (!mk || !a.date.startsWith(mes)) continue;
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
  [D.members, D.squads, D.att, D.tags, D.cfg, D.applies] = await Promise.all([
    call('members'), call('squads'), call('attendance'), call('tags'), api('/api/config'), call('applies'),
  ]);
  const n = pendentes().length;
  $('[data-tab=squads]').textContent = n ? `Squads (${n} ${n === 1 ? 'pedido' : 'pedidos'})` : 'Squads';
}

async function openPanel() {
  view('painel');
  document.querySelectorAll('[data-tab]').forEach((b) => (b.hidden = !b.dataset.roles.split(' ').includes(sess.role)));
  msg('Carregando…');
  await reload();
  showTab(tabName); // showTab limpa a mensagem, então o aviso vem depois
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
  msg('');
  run(TABS[name])();
}

// ---------- abas ----------
const TABS = {
  membros() {
    const T = $('#tab');
    const playstyles = [...new Set([...D.cfg.playstyles.map((p) => p.nome), ...D.members.flatMap((m) => m.playstyles)])];
    T.innerHTML = `<h1>Membros</h1>
      <div class="filters">
        <div class="field"><label for="f-q">Buscar</label><input id="f-q" type="search" placeholder="Nick ou Discord"></div>
        <div class="field"><label for="f-dia">Dia disponível</label><select id="f-dia"><option value="">Todos</option>${opts(Object.entries(DIAS))}</select></div>
        <div class="field"><label for="f-ps">Função</label><select id="f-ps"><option value="">Todos</option>${opts(playstyles.map((p) => [p, p]))}</select></div>
        <div class="field"><label for="f-sq">Squad (desejado ou atual)</label><select id="f-sq"><option value="">Todos</option>${opts(D.squads.map((s) => [s.id, s.nome]))}</select></div>
        <div class="field"><label for="f-st">Status</label><select id="f-st"><option value="">Todos menos removidos</option>${opts(Object.entries(STATUS))}</select></div>
        <div class="field"><label for="f-tag">Tag</label><select id="f-tag"><option value="">Todas</option>${opts(D.tags.map((t) => [t, t]))}</select></div>
      </div>
      <p class="muted" id="m-count"></p>
      <div class="table-wrap"><table>
        <thead><tr><th>Nick</th><th>Discord</th><th>Fuso</th><th>Status</th><th>Squad</th><th>Nota</th><th>Frequência</th><th>Tags</th></tr></thead>
        <tbody id="m-rows"></tbody>
      </table></div>`;
    const draw = () => {
      const q = $('#f-q').value.toLowerCase();
      const [dia, ps, sq, st, tag] = ['#f-dia', '#f-ps', '#f-sq', '#f-st', '#f-tag'].map((s) => $(s).value);
      const rows = D.members.filter((m) => !m.candidato)
        .filter((m) => (!q || `${m.nick} ${m.discord}`.toLowerCase().includes(q))
          && (!dia || m.dias.includes(dia))
          && (!ps || m.playstyles.includes(ps))
          && (!sq || m.squad === sq || m.squadDesejado === sq)
          && (st ? m.status === st : m.status !== 'removido')
          && (!tag || m.tags.includes(tag)))
        .sort((a, b) => a.nick.localeCompare(b.nick));
      $('#m-count').textContent = `${rows.length} ${rows.length === 1 ? 'membro' : 'membros'}`;
      $('#m-rows').innerHTML = rows.map((m) => `<tr>
        <td><button type="button" class="linkish" data-ficha="${esc(m.id)}">${esc(m.nick)}</button></td>
        <td>${esc(m.discord)}</td>
        <td>${esc(m.fuso)}</td>
        <td>${STATUS[m.status]}</td>
        <td>${esc(sqName(m.squad)) || '<span class="muted">-</span>'}</td>
        <td>${esc(m.nota ?? '-')}</td>
        <td>${fmtFreq(freq(m.id))}</td>
        <td>${m.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join(' ')}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">Nenhum membro com esses filtros.</td></tr>';
    };
    T.querySelectorAll('.filters input, .filters select').forEach((el) => (el.oninput = draw));
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
        <div class="actions"><button class="primary" type="submit">Salvar presença</button></div>
      </form>
      <h2>Frequência</h2>
      <div class="field narrow"><label for="p-mes">Mês</label><select id="p-mes"></select></div>
      <p class="muted">Em vermelho: menos de 60% de presença, com 3 dias de guerra ou mais marcados.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Nick</th><th>Presente</th><th>Faltou</th><th>Justificou</th><th>Frequência</th><th>Ocorrências</th></tr></thead>
        <tbody id="p-freq"></tbody>
      </table></div>`;
    const drawFreq = () => {
      const sel = $('#p-mes');
      const atual = sel.value || today.slice(0, 7);
      const meses = mesesAte(D.att.map((a) => a.date.slice(0, 7)), today.slice(0, 7));
      sel.innerHTML = meses.map((ym) => `<option value="${ym}"${ym === atual ? ' selected' : ''}>${nomeMes(ym)}</option>`).join('')
        + `<option value="tudo"${atual === 'tudo' ? ' selected' : ''}>Todos os meses</option>`;
      const mes = sel.value === 'tudo' ? '' : sel.value;
      $('#p-freq').innerHTML = active().map((m) => {
        const f = freq(m.id, mes);
        return `<tr><td>${esc(m.nick)}</td><td>${f.presente}</td><td>${f.faltou}</td><td>${f.justificou}</td><td>${fmtFreq(f)}</td><td>${f.ocorrencias || '-'}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">Nenhum membro ativo.</td></tr>';
    };
    $('#p-mes').onchange = drawFreq;
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
      await call('attendance', { method: 'POST', body: { date, marks } });
      D.att = await call('attendance');
      msg(`Presença de ${brDate(date)} salva.`);
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
        <h2>${esc(s.nome)}</h2>
        ${s.estilo ? `<p class="meta">${esc(s.estilo)}</p>` : ''}
        <p class="meta">Líder: ${esc(s.lider || 'a definir')}</p>
        ${s.funcoes?.length ? `<p class="meta">Precisa de: ${s.funcoes.map(esc).join(', ')}</p>` : ''}
        <p><span class="count">${ms.length - nRes}</span> <span class="muted">${ms.length - nRes === 1 ? 'fixo' : 'fixos'}, ${nRes} ${nRes === 1 ? 'reserva' : 'reservas'}</span></p>
        ${ms.length ? `<ul class="vagas">${ms.map((m) => `<li><span>${esc(m.nick)}</span>${pode(s)
          ? `<select data-vaga="${esc(m.id)}" aria-label="Vaga de ${esc(m.nick)}">${opts([['fixo', 'Fixo'], ['reserva', 'Reserva']], m.vaga === 'reserva' ? 'reserva' : 'fixo')}</select>`
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
      </form>`;
    $('#f-wh').onsubmit = run(async (e) => {
      e.preventDefault();
      await call('webhook', { method: 'POST', body: { url: e.target.url.value.trim() } });
      await TABS.discord();
      msg('Webhook salvo. Clique em "Enviar teste" pra conferir no Discord.');
    });
    T.onclick = run(async (e) => {
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
        <div class="actions"><button class="primary" type="submit">Salvar config</button></div>
      </form>`;
    $('#f-cfg').onsubmit = run(async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const playstyles = fd.get('playstyles').split('\n').map((l) => {
        const [nome, ...desc] = l.split('|');
        return { nome: nome.trim(), desc: desc.join('|').trim() };
      }).filter((p) => p.nome);
      D.cfg = await call('config', { method: 'POST', body: { horario: fd.get('horario'), regras: fd.get('regras'), playstyles } });
      msg('Config salva. O site já mostra os novos valores.');
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
      <div class="actions"><button type="button" class="primary" data-csv>Baixar membros + presença (CSV)</button><button type="button" data-bk>Baixar backup completo (JSON)</button></div>
      <h2>Importar backup</h2>
      <p class="muted">Sobrescreve os itens que tiverem a mesma chave. Usuários do painel e imagens não entram no backup.</p>
      <form id="f-imp" class="narrow">
        <div class="field"><label for="imp-file">Arquivo de backup (.json)</label><input id="imp-file" type="file" accept="application/json,.json" required></div>
        <div class="actions"><button type="submit">Importar backup</button></div>
      </form>`;
    T.onclick = run(async (e) => {
      if (e.target.closest('[data-csv]')) download('membros-presenca.csv', csv(), 'text/csv;charset=utf-8');
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
  },
};

function ficha(id) {
  const m = D.members.find((x) => x.id === id);
  const admin = isAdmin();
  const hist = D.att.filter((a) => a.marks[id]).sort((a, b) => b.date.localeCompare(a.date));
  const row = (k, v) => (v ? `<tr><th scope="row">${k}</th><td class="pre">${esc(v)}</td></tr>` : '');
  dlg(`<h2 id="dlg-title">${esc(m.nick)}</h2>
    <p class="meta">Registrado em ${fmtDate(m.criadoEm)}. Frequência: ${fmtFreq(freq(id))}</p>
    <table>
      ${row('Discord', m.discord)}${row('Idade', m.idade)}${row('País', m.pais)}${row('Fuso', m.fuso)}
      ${row('Dias', m.dias.map((d) => DIAS[d]).join(', '))}
      ${row('Função', [...m.playstyles, m.playstyleOutro].filter(Boolean).join(', '))}
      ${row('Squad desejado', sqName(m.squadDesejado))}${m.squad ? row('Vaga no squad', m.vaga === 'reserva' ? 'Reserva' : 'Fixo') : ''}
      ${row('Já foi de clã', m.cla === 'sim' ? `Sim. ${m.claQual || ''}` : m.cla ? 'Não' : '')}
      ${row('Já jogou FPS', m.fps === 'sim' ? `Sim. ${m.fpsQual || ''}` : 'Não')}
      ${row('Microfone', m.mic === 'sim' ? 'Sim' : 'Não')}${row('Sobre', m.sobre)}
    </table>
    <h3>Histórico de gear</h3>
    ${m.gear.length ? m.gear.slice().reverse().map((g) => `<div class="card">
      <p class="meta">${fmtDate(g.data)}</p>${g.texto ? `<p class="pre">${esc(g.texto)}</p>` : ''}
      <div class="thumbs">${g.imgs.map((i, n) => `<a href="${imgUrl(i)}" target="_blank" rel="noopener"><img src="${imgUrl(i)}" alt="Print ${n + 1} do gear de ${fmtDate(g.data)}" loading="lazy"></a>`).join('')}</div>
    </div>`).join('') : '<p class="muted">Nenhum gear enviado.</p>'}
    <h3>Histórico de presença</h3>
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
        <div class="options">${[...new Set([...D.tags, ...m.tags])].map((t) => `<label class="check"><input type="checkbox" name="tags" value="${esc(t)}"${m.tags.includes(t) ? ' checked' : ''}> ${esc(t)}</label>`).join('')}</div>
        <div class="field"><label for="fi-nova">Criar tag nova</label><input id="fi-nova" name="novaTag" type="text" maxlength="30"></div>
      </fieldset>
      <div class="field"><label for="fi-notas">Anotações</label><textarea id="fi-notas" name="anotacoes" maxlength="3000">${esc(m.anotacoes)}</textarea></div>
      <div class="status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="primary" type="submit">Salvar ficha</button><button type="button" data-close>Fechar</button></div>
    </form>`}`);
  if (m.candidato) return;
  $('#f-ficha').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { id, nota: fd.get('nota'), anotacoes: fd.get('anotacoes'), tags: [...fd.getAll('tags'), fd.get('novaTag')].filter(Boolean) };
    if (admin) Object.assign(body, { status: fd.get('status'), squad: fd.get('squad') });
    try {
      Object.assign(m, await call('member', { method: 'POST', body }));
      D.tags = [...new Set([...D.tags, ...m.tags])];
      if (admin) D.squads = await call('squads');
      $('#dlg').close();
      msg(`Ficha de ${m.nick} salva.`);
      redraw();
    } catch (err) {
      if (err.status !== 401) say($('#f-ficha .status'), err.message, true);
    }
  };
}

function squadForm(s = { nome: '', estilo: '', lider: '', fixos: [] }) {
  dlg(`<h2 id="dlg-title">${s.id ? 'Editar squad' : 'Novo squad'}</h2>
    <form id="f-sq">
      <div class="field"><label for="sq-nome">Nome</label><input type="text" id="sq-nome" name="nome" required maxlength="40" value="${esc(s.nome)}"></div>
      <div class="field"><label for="sq-estilo">Como o squad joga <span class="hint">(descrição curta)</span></label><input type="text" id="sq-estilo" name="estilo" maxlength="100" value="${esc(s.estilo)}"></div>
      <fieldset><legend>Funções que o squad procura</legend>
        <p class="hint">O registro recomenda este squad pra quem marcar alguma delas.</p>
        <div class="options">${[...new Set([...D.cfg.playstyles.map((p) => p.nome), ...(s.funcoes || [])])].map((f) => `<label class="check"><input type="checkbox" name="funcoes" value="${esc(f)}"${s.funcoes?.includes(f) ? ' checked' : ''}> ${esc(f)}</label>`).join('')}</div>
      </fieldset>
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
      await call('squad', { method: 'POST', body: { id: s.id, nome: fd.get('nome'), estilo: fd.get('estilo'), lider: fd.get('lider'), funcoes: fd.getAll('funcoes'), fixos: fd.getAll('fixos') } });
      await reload();
      $('#dlg').close();
      await TABS.squads();
      msg(`Squad ${fd.get('nome')} salvo.`);
    } catch (err) {
      if (err.status !== 401) say($('#f-sq .status'), err.message, true);
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
      <tbody>${posts.map((p) => `<tr><td>${esc(p.titulo)}</td><td>${fmtDate(p.data)}</td><td>${p.publico ? 'Todo mundo' : 'Só admins'}</td>
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
  const dates = D.att.map((a) => a.date).sort();
  const head = ['Nick', 'Discord', 'Idade', 'País', 'Fuso', 'Dias', 'Funções', 'Squad desejado', 'Squad atual', 'Status', 'Nota', 'Tags',
    'Microfone', 'Já foi de clã', 'Quais clãs', 'Já jogou FPS', 'Quais FPS', 'Registro', 'Presenças', 'Faltas', 'Justificadas', 'Frequência %', ...dates.map(brDate)];
  const sn = (v) => ({ sim: 'Sim', nao: 'Não' })[v] || '';
  const rows = D.members.map((m) => {
    const f = freq(m.id);
    const porData = dates.map((d) => {
      const mk = D.att.find((a) => a.date === d).marks[m.id];
      return mk ? ATT[mk.s] + (mk.j ? `: ${mk.j}` : '') : '';
    });
    return [m.nick, m.discord, m.idade, m.pais, m.fuso, m.dias.map((d) => DIAS[d]).join(' '), [...m.playstyles, m.playstyleOutro].filter(Boolean).join(', '),
      sqName(m.squadDesejado), sqName(m.squad), STATUS[m.status], m.nota ?? '', m.tags.join(', '), sn(m.mic), sn(m.cla), m.claQual, sn(m.fps), m.fpsQual,
      fmtDate(m.criadoEm), f.presente, f.faltou, f.justificou, f.pct ?? '', ...porData];
  });
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
      <label class="check"><input type="checkbox" name="publico"${p.publico ? ' checked' : ''}> Público (aparece no site pra todo mundo). Desmarcado: só admins veem.</label>
      ${p.id ? '<div class="field"><span>Imagens do post</span><div class="previews" id="po-keep"></div></div>' : ''}
      <div class="field"><label for="po-f">Adicionar imagens <span class="hint">(até 10 por vez, JPG/PNG/WEBP)</span></label><input id="po-f" type="file" accept="image/jpeg,image/png,image/webp" multiple></div>
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
  const picker = imagePicker($('#po-f'), $('#po-new'), 10, st);
  $('#f-post').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = $('[type=submit]', f);
    btn.disabled = true;
    say(st, 'Salvando…');
    try {
      let ids = [];
      if (picker.get().length) {
        const fd = new FormData();
        picker.get().forEach((b, i) => fd.append('prints', b, `img${i + 1}.jpg`));
        ids = await call('upload', { method: 'POST', body: fd });
      }
      await call('post', { method: 'POST', body: { id: p.id, titulo: f.titulo.value, texto: f.texto.value, publico: f.publico.checked, tipo, imgs: [...keep, ...ids] } });
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
