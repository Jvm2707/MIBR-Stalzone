// Conta do membro no site: Entrar, Meu registro, Membros, Perfil e Ranking.
// Quem decide o que cada um vê é o Worker (allowlist por cargo); aqui só desenhamos o que chegou.
(() => {
  if (!document.getElementById('f-registro')) return;
  const $ = (s, el = document) => el.querySelector(s);
  const APROVADOS = ['teste', 'membro', 'veterano'];
  const STATUS = { pendente: 'Aguardando aprovação', recusado: 'Recusado', teste: 'Em teste', membro: 'Membro', veterano: 'Veterano', removido: 'Removido', suspenso: 'Sem acesso' };
  const DIAS = { seg: 'Seg', ter: 'Ter', qua: 'Qua', qui: 'Qui', sex: 'Sex', sab: 'Sáb', dom: 'Dom' };
  const ler = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const gravar = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* sem storage */ } };
  // link de acesso mandado por um admin: #acesso/<token> guarda o acesso neste navegador
  const doLink = location.hash.match(/^#acesso\/([0-9a-f]{64})$/)?.[1];
  if (doLink) { gravar('msess', doLink); history.replaceState(null, '', '#meu'); }
  let token = ler('msess');
  // alguém da equipe logado no painel (mesmo navegador) também vê as páginas de membro
  const admin = (() => { try { const s = JSON.parse(ler('sess')); return s?.token ? s : null; } catch { return null; } })();
  let me = null;
  const cfg = () => window.D_SITE?.cfg || {};
  const st = (x) => esc(t(STATUS[x] || x));

  window.meuNick = () => me?.nick; // apply de quem já tem registro vai com o nick dele
  window.tokenSite = () => token || admin?.token;
  // visitante = ainda não se registrou neste navegador (só ele vê a aba Registro)
  window.podeVer = (so) => (so === 'visitante' ? !token
    : so === 'logado' ? !!token
      : so === 'membro' ? !!admin || !!(me && APROVADOS.includes(me.status) && !me.mustChange) : true);

  function atualizarMenu() {
    document.querySelectorAll('.top nav [data-so]').forEach((a) => (a.hidden = !window.podeVer(a.dataset.so)));
    window.renderSquadsSite?.(); // nick vira link pro perfil só pra membro
    if (window.podeVer('membro')) window.carregarPosts?.();
    window.SHOW_SITE?.(false); // reaplica o bloqueio da página aberta
  }
  async function carregarMe() {
    me = null;
    if (token) {
      try { me = await api('/api/me', { token }); } catch (e) { if (e.status === 401) { token = null; gravar('msess', null); } }
    }
    atualizarMenu();
  }
  window.entrou = async (tk) => { token = tk; gravar('msess', tk); await carregarMe(); location.hash = '#meu'; };
  const sair = () => { token = null; me = null; gravar('msess', null); atualizarMenu(); location.hash = '#registro'; };

  // ---- KDA (mesmo jeito do painel) ----
  const rt = (s) => (s.k + s.a) / Math.max(s.d, 1);
  const kdaTxt = (s) => `Kill (${s.k}) / Death (${s.d}) / Assist (${s.a}) / Rating (${rt(s).toFixed(2)})`;
  const somar = (ls) => ls.reduce((s, l) => ({ k: s.k + l.kills, d: s.d + l.deaths, a: s.a + l.assists, jogos: s.jogos + 1 }), { k: 0, d: 0, a: 0, jogos: 0 });
  const seasonDe = (x) => x.season || (cfg().seasons || []).find((s) => s.inicio <= x.date && x.date <= s.fim)?.id || '';
  const naSeason = (x, sea) => sea === 'tudo' || seasonDe(x) === sea;
  const selSeason = (id, valor) => `<div class="field narrow"><label for="${id}">Season</label><select id="${id}">
    ${(cfg().seasons || []).slice().reverse().map((s) => `<option value="${esc(s.id)}"${s.id === valor ? ' selected' : ''}>${esc(s.nome)}${s.id === cfg().seasonAtual ? ` (${esc(t('atual'))})` : ''}</option>`).join('')}
    <option value="tudo"${valor === 'tudo' ? ' selected' : ''}>All time</option></select></div>`;
  const linkNick = (id, nick) => (id ? `<a href="#perfil/${esc(id)}">${esc(nick)}</a>` : esc(nick));
  const erro = (box, e) => { box.innerHTML = `<p class="status bad">${esc(tErr(e.message))}</p>`; };
  const carregando = (box) => { box.innerHTML = `<p class="muted">${esc(t('Carregando…'))}</p>`; };
  const fotos = (g, quem) => `<div class="thumbs">${g.imgs.map((i, n) => `<a href="${imgUrl(i)}" target="_blank" rel="noopener"><img src="${imgUrl(i)}" alt="${esc(t('Print {n}', { n: n + 1 }))} ${esc(quem)}" loading="lazy"></a>`).join('')}</div>`;
  // print de gear antiga some em 60 dias: no lugar da imagem quebrada, um aviso
  const marcarExpiradas = (box) => box.querySelectorAll('.thumbs img').forEach((img) => img.addEventListener('error', () => {
    const p = document.createElement('span'); p.className = 'pill'; p.textContent = t('print expirada'); img.closest('a').replaceWith(p);
  }));

  // ---- Membros ----
  async function membros() {
    const box = $('#membros-box');
    carregando(box);
    let ps;
    try { ps = await api('/api/profiles', { token: window.tokenSite() }); } catch (e) { return erro(box, e); }
    box.innerHTML = `<div class="field narrow"><label for="mb-q">${esc(t('Buscar'))}</label><input id="mb-q" type="search"></div>
      <div class="table-wrap"><table><thead><tr><th>Nick</th><th>Status</th><th>Squad</th><th>${esc(t('Função'))}</th><th>${esc(t('Tipo de gear'))}</th><th>Tags</th></tr></thead><tbody id="mb-rows"></tbody></table></div>`;
    const draw = () => {
      const q = $('#mb-q').value.toLowerCase();
      $('#mb-rows').innerHTML = ps.filter((p) => p.nick.toLowerCase().includes(q)).sort((a, b) => a.nick.localeCompare(b.nick)).map((p) => `<tr>
        <td>${linkNick(p.id, p.nick)}</td><td>${st(p.status)}</td><td>${esc(p.squad) || '-'}</td>
        <td>${esc(p.playstyles.map((x) => t(x)).join(', ')) || '-'}</td><td>${esc(p.gearTipos.map((x) => t(x)).join(', ')) || '-'}</td>
        <td>${p.tags.map((x) => `<span class="pill">${esc(x)}</span>`).join(' ')}</td></tr>`).join('')
        || `<tr><td colspan="6" class="muted">${esc(t('Ninguém com esse nick.'))}</td></tr>`;
    };
    $('#mb-q').oninput = draw;
    draw();
  }

  // ---- Ranking (season escolhida; padrão = atual) ----
  async function ranking() {
    const box = $('#ranking-box');
    carregando(box);
    let rs;
    try { rs = await api('/api/ranking', { token: window.tokenSite() }); } catch (e) { return erro(box, e); }
    let sea = cfg().seasonAtual || 'tudo';
    const draw = (foco) => {
      const por = {};
      for (const r of rs.filter((x) => naSeason(x, sea))) for (const l of r.linhas) {
        const k = l.memberId || 'ex:' + l.nick;
        (por[k] ||= { id: l.memberId, nick: l.nick, ls: [] }).ls.push(l);
      }
      // padrão do clã: maior média de kills por game; empate, maior Rating
      const lista = Object.values(por).map((x) => ({ ...x, s: somar(x.ls) })).sort((a, b) => b.s.k / b.s.jogos - a.s.k / a.s.jogos || rt(b.s) - rt(a.s));
      box.innerHTML = `${selSeason('rk-sea', sea)}<p class="muted">${esc(t('Ordem: maior média de kills por game (empate: maior Rating).'))}</p>
        <div class="table-wrap"><table><thead><tr><th>#</th><th>Nick</th><th>Games</th><th>KDA</th></tr></thead><tbody>
        ${lista.map((x, i) => `<tr><td>${i + 1}</td><td>${linkNick(x.id, x.nick)}</td><td>${x.s.jogos}</td><td>${esc(kdaTxt(x.s))}</td></tr>`).join('')
          || `<tr><td colspan="4" class="muted">${esc(t('Nenhum game nesse período.'))}</td></tr>`}</tbody></table></div>`;
      $('#rk-sea').onchange = (e) => { sea = e.target.value; draw(true); };
      if (foco) $('#rk-sea').focus();
    };
    draw();
  }

  // ---- Perfil (só os campos que o Worker deixa sair) ----
  async function perfil() {
    const box = $('#perfil-box');
    const id = location.hash.split('/')[1] || '';
    carregando(box);
    let p;
    try { p = await api('/api/profile/' + encodeURIComponent(id), { token: window.tokenSite() }); } catch (e) { return erro(box, e); }
    $('#h-perfil').textContent = p.nick;
    let sea = cfg().seasonAtual || 'tudo';
    const linha = (k, v) => (v ? `<tr><th scope="row">${esc(t(k))}</th><td>${esc(v)}</td></tr>` : '');
    const draw = (foco) => {
      const s = somar(p.kda.filter((x) => naSeason(x, sea)));
      box.innerHTML = `${me?.id === p.id ? `<div class="actions"><a class="btn primary" href="#meu">${esc(t('Editar meu registro'))}</a></div>` : ''}
        ${admin ? `<p><a href="admin.html#ficha/${esc(p.id)}">${esc(t('Só equipe: abrir a ficha completa no painel'))}</a></p>` : ''}
        <table>
          ${linha('Status', t(STATUS[p.status] || p.status))}${linha('Squad', p.squad)}
          ${linha('Função', [...p.playstyles.map((x) => t(x)), p.playstyleOutro].filter(Boolean).join(', '))}
          ${linha('Tipo de gear', p.gearTipos.map((x) => t(x)).join(', '))}
          ${linha('Microfone', t(p.mic === 'sim' ? 'Sim' : 'Não'))}${linha('Dias que pode jogar', p.dias.map((d) => t(DIAS[d])).join(', '))}
          ${p.tags.length ? `<tr><th scope="row">Tags</th><td>${p.tags.map((x) => `<span class="pill">${esc(x)}</span>`).join(' ')}</td></tr>` : ''}
        </table>
        <h2>${esc(t('KDA de guerra'))}</h2>${selSeason('pf-sea', sea)}
        ${s.jogos ? `<p><strong>${esc(kdaTxt(s))}</strong> <span class="muted">${esc(t('em {n} games', { n: s.jogos }))}</span></p>` : `<p class="muted">${esc(t('Nenhum game nesse período.'))}</p>`}
        <h2>Gear</h2>
        ${p.gear.slice().reverse().map((g) => `<div class="card"><p class="meta">${fmtDate(g.data)}</p>
          ${g.tipos.length ? `<p>${g.tipos.map((x) => `<span class="pill">${esc(t(x))}</span>`).join(' ')}</p>` : ''}
          ${g.texto ? `<p class="pre">${esc(g.texto)}</p>` : ''}${fotos(g, p.nick)}</div>`).join('') || `<p class="muted">${esc(t('Nenhum gear ainda.'))}</p>`}`;
      $('#pf-sea').onchange = (e) => { sea = e.target.value; draw(true); };
      marcarExpiradas(box);
      if (foco) $('#pf-sea').focus();
    };
    draw();
  }

  // mesmo exemplo que aparece no registro (copiado do index.html)
  const EXEMPLO_GEAR = () => document.querySelector('#f-registro details.exemplo')?.outerHTML || '';

  // ---- Meu registro ----
  const checks = (nome, todos, marcados, rotulo = (x) => t(x)) => `<div class="options">${todos.map((x) => `<label class="check"><input type="checkbox" name="${nome}" value="${esc(x)}"${marcados.includes(x) ? ' checked' : ''}> ${esc(rotulo(x))}</label>`).join('')}</div>`;
  const simNao = (nome, v, id) => `<div class="options" role="radiogroup" aria-labelledby="${id}">${[['sim', 'Sim'], ['nao', 'Não']].map(([val, l]) => `<label class="check"><input type="radio" name="${nome}" value="${val}"${(v === 'sim') === (val === 'sim') ? ' checked' : ''}> ${esc(t(l))}</label>`).join('')}</div>`;
  const campo = (nome, rot, v, max, tipo = 'text') => `<div class="field"><label for="mr-${nome}">${esc(t(rot))}</label><input type="${tipo}" id="mr-${nome}" name="${nome}" maxlength="${max}" value="${esc(v)}"></div>`;
  const fusos = () => {
    const gmt = (min) => `GMT${min < 0 ? '-' : '+'}${Math.floor(Math.abs(min) / 60)}${Math.abs(min) % 60 ? ':' + String(Math.abs(min) % 60).padStart(2, '0') : ''}`;
    const lista = [...new Set([...Array.from({ length: 27 }, (_, i) => gmt((i - 12) * 60)), me.fuso].filter(Boolean))];
    return `<div class="field"><label for="mr-fuso">${esc(t('Fuso horário'))}</label><select id="mr-fuso" name="fuso">${lista.map((f) => `<option${f === me.fuso ? ' selected' : ''}>${f}</option>`).join('')}</select></div>`;
  };

  async function meu() {
    if (!me) await carregarMe();
    const box = $('#meu-box');
    if (!me) return erro(box, { message: 'Faça seu registro primeiro (ou peça um link de acesso pra um admin).' });
    {
      const aviso = { pendente: 'Seu registro está aguardando a aprovação de um admin. Enquanto isso, você pode conferir e editar seus dados.', recusado: 'Seu registro foi recusado. Tente novamente: exclua seu registro no fim da página e registre de novo.', suspenso: 'Seu acesso de membro está suspenso. Fale com um admin.', removido: 'Você não está mais ativo no clã. Fale com um admin.' }[me.status];
      const s = somar(me.kda);
      const funcoes = [...new Set([...(cfg().playstyles || []).map((p) => p.nome), 'Não tenho preferência', ...me.playstyles])];
      const tiposGear = cfg().gearTipos?.length ? cfg().gearTipos : ['Speed', 'Tank', 'Híbrido'];
      box.innerHTML = `<p class="status${aviso ? ' bad' : ''}">Status: <strong>${st(me.status)}</strong>${aviso ? `. ${esc(t(aviso))}` : ''}</p>
        ${me.motivoRecusa ? `<p class="status bad">${esc(t('Motivo'))}: ${esc(me.motivoRecusa)}</p>` : ''}
        <table>${me.squad ? `<tr><th scope="row">Squad</th><td>${esc(me.squad)}</td></tr>` : ''}
          ${me.tags.length ? `<tr><th scope="row">Tags</th><td>${me.tags.map((x) => `<span class="pill">${esc(x)}</span>`).join(' ')}</td></tr>` : ''}
          ${s.jogos ? `<tr><th scope="row">KDA (all time)</th><td>${esc(kdaTxt(s))}</td></tr>` : ''}</table>
        ${APROVADOS.includes(me.status) ? `<p><a href="#perfil/${esc(me.id)}">${esc(t('Ver meu perfil como os outros veem'))}</a></p>` : ''}
        <h2>${esc(t('Meus dados'))}</h2>
        <form id="mr-dados">
          <div class="row">${campo('nick', 'Nick no jogo', me.nick, 32)}${campo('discord', 'Discord', me.discord, 40)}</div>
          <div class="row">${campo('idade', 'Idade', me.idade, 3)}${campo('pais', 'País', me.pais, 60)}${fusos()}</div>
          <fieldset><legend>${esc(t('Dias que pode jogar'))}</legend>${checks('dias', Object.keys(DIAS), me.dias, (d) => t(DIAS[d]))}</fieldset>
          <fieldset><legend>${esc(t('Função'))}</legend>${checks('playstyles', funcoes, me.playstyles)}</fieldset>
          ${campo('playstyleOutro', 'Outra função ou detalhe', me.playstyleOutro, 100)}
          <fieldset><legend>${esc(t('Tipo de gear'))}</legend>${checks('gearTipos', tiposGear, me.gearTipos)}</fieldset>
          <div class="field"><span id="mr-cla-q">${esc(t('Já foi de algum clã no Stalzone?'))}</span>${simNao('cla', me.cla, 'mr-cla-q')}</div>
          ${campo('claQual', 'Qual ou quais clãs, e por quanto tempo?', me.claQual, 200)}
          <div class="field"><span id="mr-fps-q">${esc(t('Já jogou outro FPS?'))}</span>${simNao('fps', me.fps, 'mr-fps-q')}</div>
          ${campo('fpsQual', 'Qual ou quais, seu rank mais alto e por quanto tempo?', me.fpsQual, 200)}
          <div class="field"><span id="mr-mic-q">${esc(t('Tem microfone?'))}</span>${simNao('mic', me.mic, 'mr-mic-q')}</div>
          <div class="field"><label for="mr-sobre">${esc(t('Fale sobre você'))}</label><textarea id="mr-sobre" name="sobre" maxlength="1000">${esc(me.sobre)}</textarea></div>
          <div class="status" role="status" aria-live="polite"></div>
          <div class="actions"><button class="primary" type="submit">${esc(t('Salvar meus dados'))}</button></div>
        </form>
        <h2>${esc(t('Atualizar gear'))}</h2>
        <form id="mr-gear">
          <fieldset><legend>${esc(t('Tipo de gear'))}</legend>${checks('gearTipo', tiposGear, [])}</fieldset>
          ${EXEMPLO_GEAR()}
          <div class="field"><label for="mr-gtxt">${esc(t('Gear atual'))}</label><textarea id="mr-gtxt" name="gear" maxlength="1000"></textarea></div>
          <div class="field"><label for="mr-gprints">${esc(t('Prints'))} <span class="hint">${esc(t('(até 4, JPG/PNG/WEBP)'))}</span></label><input id="mr-gprints" type="file" accept="image/jpeg,image/png,image/webp" multiple></div>
          <div class="previews"></div>
          <div class="status" role="status" aria-live="polite"></div>
          <div class="actions"><button class="primary" type="submit">${esc(t('Enviar gear'))}</button></div>
        </form>
        ${me.gear.length ? `<h3>${esc(t('Meu histórico de gear'))}</h3>${me.gear.slice().reverse().map((g) => `<div class="card"><p class="meta">${fmtDate(g.data)}</p>${g.tipos.length ? `<p>${g.tipos.map((x) => `<span class="pill">${esc(t(x))}</span>`).join(' ')}</p>` : ''}${g.texto ? `<p class="pre">${esc(g.texto)}</p>` : ''}${fotos(g, me.nick)}</div>`).join('')}` : ''}
        <h2>${esc(t('Excluir meu registro'))}</h2>
        <form id="mr-excluir">
          <p class="hint">${esc(t('Apaga seus dados e suas prints. Não dá pra desfazer. Presença e resultados antigos ficam como "ex-membro". Depois disso a aba Registro volta.'))}</p>
          <div class="status" role="status" aria-live="polite"></div>
          <div class="actions"><button type="submit" class="danger">${esc(t('Excluir meu registro'))}</button></div>
        </form>
        `;
      marcarExpiradas(box);
      const fd = $('#mr-dados');
      fd.onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(fd);
        const dados = Object.fromEntries(['nick', 'discord', 'idade', 'pais', 'fuso', 'playstyleOutro', 'cla', 'claQual', 'fps', 'fpsQual', 'mic', 'sobre'].map((k) => [k, (f.get(k) || '').trim()]));
        Object.assign(dados, { dias: f.getAll('dias'), playstyles: f.getAll('playstyles'), gearTipos: f.getAll('gearTipos') });
        try { me = await api('/api/me', { method: 'POST', body: dados, token }); await meu(); say($('#mr-dados .status'), t('Dados salvos.')); } catch (err) { say($('.status', fd), tErr(err.message), true); }
      };
      const fg = $('#mr-gear');
      const picker = imagePicker($('#mr-gprints'), $('.previews', fg), 4, $('.status', fg));
      fg.onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(fg);
        picker.get().forEach((b, i) => f.append('prints', b, `print${i + 1}.jpg`));
        say($('.status', fg), t('Enviando…'));
        try { await api('/api/me/gear', { method: 'POST', body: f, token }); picker.clear(); await carregarMe(); await meu(); say($('#mr-gear .status'), t('Gear enviado! Ele já está no seu histórico.')); } catch (err) { say($('.status', fg), tErr(err.message), true); }
      };
      const fx = $('#mr-excluir');
      fx.onsubmit = async (e) => {
        e.preventDefault();
        if (!confirm(t('Excluir seu registro de vez? Não dá pra desfazer.'))) return;
        try { await api('/api/me/delete', { method: 'POST', body: {}, token }); sair(); alert(t('Seu registro foi excluído.')); } catch (err) { say($('.status', fx), tErr(err.message), true); }
      };
    }
  }

  window.aoMostrar = (id) => {
    if (id === 'meu') meu();
    if (id === 'membros') membros();
    if (id === 'ranking') ranking();
    if (id === 'perfil') perfil();
  };
  carregarMe();
})();
