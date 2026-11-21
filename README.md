# Site do clã (Stalzone)

Duas partes:

- **`site/`**: as páginas (registro, avisos, gear, squads, regras, táticas e o painel `admin.html`). É HTML, CSS e JS puro, sem build e sem npm. Vai pro **GitHub Pages**.
- **`worker/`**: a API, num **Cloudflare Worker** com **KV** (tudo no plano grátis). Ela guarda os dados, confere o captcha, manda os avisos pro Discord e controla quem pode fazer o quê no painel.

> O repositório é **público**. Nenhuma senha, webhook ou token vai no código. Eles ficam nos *secrets* do Worker. O `site/config.js` só tem a URL do Worker e a *site key* do Turnstile, e as duas são públicas por natureza.

---

## Passo a passo

### 1. Criar a conta grátis na Cloudflare

1. Entre em <https://dash.cloudflare.com/sign-up> e crie a conta (o plano Free basta).
2. Confirme o e-mail.

### 2. Criar o Worker e o KV

Você pode fazer isso **pelo painel** (mais fácil) ou **pelo terminal com o wrangler**. Escolha um dos dois.

#### Opção A: pelo painel (sem instalar nada)

1. No painel da Cloudflare, vá em **Storage & Databases → KV** e clique em **Create a namespace**. Dê o nome `stalzone-cla` e crie.
2. Vá em **Compute (Workers) → Workers & Pages → Create → Create Worker**. Dê o nome `stalzone-cla` e clique em **Deploy** (ele cria um "Hello World").
3. Clique em **Edit code**, apague tudo que estiver lá, cole o conteúdo inteiro de `worker/worker.js` e clique em **Deploy**.
4. Volte na página do Worker → **Settings → Bindings → Add → KV namespace**:
   - *Variable name*: `KV` (exatamente assim, em maiúsculas)
   - *KV namespace*: `stalzone-cla`
5. Ainda em **Settings → Variables and Secrets → Add**:
   - *Type* **Text**, nome `ALLOWED_ORIGIN`, valor = o endereço do seu site no GitHub Pages, **sem barra no final e sem o nome do repositório**. Exemplo: `https://seu-usuario.github.io`.

#### Opção B: pelo terminal (wrangler)

Precisa do Node.js instalado.

```powershell
cd worker
```

```powershell
npx wrangler login
```

```powershell
npx wrangler kv namespace create KV
```

O último comando mostra um `id`. Cole esse id em `worker/wrangler.toml`, no lugar de `COLE_AQUI_O_ID_DO_KV`. No mesmo arquivo, troque `https://SEU-USUARIO.github.io` pelo endereço do seu site. Depois publique:

```powershell
npx wrangler deploy
```

### 3. Configurar os secrets

São 5 secrets. **Pelo painel**: Worker → **Settings → Variables and Secrets → Add**, *Type* **Secret**. **Pelo terminal**: `npx wrangler secret put NOME` (ele pede o valor).

| Nome | O que colocar |
|---|---|
| `DISCORD_WEBHOOK` | **Opcional.** Tudo já aparece no painel; o webhook só manda uma cópia pro Discord. No Discord: Configurações do canal → Integrações → Webhooks → Novo webhook → **Copiar URL**. |
| `TURNSTILE_SECRET` | A *secret key* do Turnstile (passo 4). |
| `RSVP_TOKEN` | Uma senha longa e aleatória inventada por você (ex.: 40 letras e números). O bot de presença vai usar no futuro. |
| `SUPERADMIN_USER` | O usuário do dono do painel (ex.: `chefe`). |
| `SUPERADMIN_PASS` | A senha do dono. Use uma senha forte: ela só pode ser trocada aqui, nos secrets. |

### 4. Criar a chave do Turnstile (o captcha)

1. No painel da Cloudflare: **Turnstile → Add widget**.
2. Nome: `site do clã`. Em **Hostnames**, adicione `seu-usuario.github.io`. Modo: **Managed**.
3. A Cloudflare mostra duas chaves:
   - **Site key**: vai no `site/config.js`, no campo `TURNSTILE_SITEKEY`. É pública.
   - **Secret key**: vai no secret `TURNSTILE_SECRET` do Worker (passo 3). **Nunca** coloque no site.

### 5. Colocar a URL do Worker no `site/config.js`

A URL aparece na página do Worker. Algo como `https://stalzone-cla.seu-usuario.workers.dev`. Abra `site/config.js` e troque:

```js
API: 'https://stalzone-cla.seu-usuario.workers.dev',
TURNSTILE_SITEKEY: 'sua-site-key-do-passo-4',
```

### 6. Publicar no GitHub Pages

1. Suba esta pasta pro seu repositório no GitHub.
2. No repositório: **Settings → Pages**.
3. Em *Source*, escolha **Deploy from a branch**, branch `main`, pasta **`/ (root)`**, e salve.
4. O site fica em `https://seu-usuario.github.io/NOME-DO-REPO/site/` (o painel em `.../site/admin.html`).

> Quer o site direto em `https://seu-usuario.github.io/NOME-DO-REPO/`? Mova o conteúdo de `site/` pra raiz do repositório. O `ALLOWED_ORIGIN` continua o mesmo (`https://seu-usuario.github.io`).

### 7. Entrar no painel e criar sn e ariellor

1. Abra `.../site/admin.html` e entre com `SUPERADMIN_USER` e `SUPERADMIN_PASS`.
2. Aba **Equipe → Novo usuário**:
   - usuário `sn`, cargo **Admin**, uma senha provisória (8 caracteres ou mais) → **Criar usuário**.
   - usuário `ariellor`, cargo **Admin**, outra senha provisória → **Criar usuário**.
3. Passe a senha provisória pra cada um (no privado). No primeiro login o painel obriga a trocar.
4. Na aba **Config**, confira o horário da guerra, escreva as regras e ajuste as funções (Livre, Suporte, Sniper, Tank), cada uma com sua descrição.
5. Na aba **Squads**, crie os squads e marque as **funções que cada um procura**. O registro usa isso pra recomendar um squad pra quem se inscreve.
6. Na aba **Avisos**, publique os recados pro clã. Eles aparecem na página **Avisos** do site.

Pronto.

---

## Como funciona

### Cargos (o Worker confere em **toda** rota; o site só esconde os botões)

| Cargo | Pode |
|---|---|
| **superadmin** | Tudo, mais as abas **Equipe**, **Config** e **Log**. Vem só dos secrets: não dá pra remover nem editar pelo site. |
| **admin** | Membros, presença, squads, applies, avisos, táticas, exportar e importar. |
| **lider_squad** | Só o próprio squad: ver os membros dele, dar nota, tags e anotações, marcar presença e responder os applies desse squad. |

- Senhas com hash PBKDF2 (100 mil iterações) + salt no KV.
- Sessão dura 7 dias. Trocar o cargo, resetar a senha ou remover um usuário derruba as sessões dele na hora.
- 5 senhas erradas seguidas bloqueiam aquele usuário por 15 minutos.

### Anti-spam nos envios públicos (registro, gear, apply)

- Captcha Turnstile obrigatório.
- No máximo 3 envios por hora por IP.
- CORS liberado só pro endereço do `ALLOWED_ORIGIN`.
- Texto com link (`http`, `www.`, `t.me`, `telegram`, `discord.gg`) ou com `@everyone`/`@here` é recusado.
- Todos os campos têm limite de tamanho. Imagens: só JPG/PNG/WEBP (o Worker confere o conteúdo do arquivo, não só o nome), até 4, cada uma comprimida no navegador pra no máximo ~1 MB.
- O aviso no Discord sai com `allowed_mentions` vazio: nunca pinga ninguém.

### Bot de presença (futuro): `POST /api/rsvp`

```http
POST https://stalzone-cla.seu-usuario.workers.dev/api/rsvp
Authorization: Bearer <RSVP_TOKEN>
Content-Type: application/json

[{ "date": "2026-11-21", "nick": "Fulano", "status": "vai" }]
```

`status` aceita `vai`, `talvez` ou `nao`. Dá pra mandar um item só ou uma lista com até 200. A confirmação aparece ao lado do nick na aba **Presença**, quando o nick do bot é igual ao nick do registro.

### Limites do plano grátis que vale saber

- KV grátis: 100 mil leituras e **1000 gravações por dia**. Pra um clã é de sobra, mas importar um backup muito grande pode estourar: importe em partes.
- Cada requisição pode fazer até 1000 operações no KV. O painel lê cada membro separadamente, então funciona bem até algumas centenas de membros.
- O KV leva até 1 minuto pra mostrar uma mudança em outras regiões do mundo. Um registro recém-enviado pode demorar um pouco pra aparecer no painel.
- As imagens ficam no próprio KV (até 25 MB cada; as nossas têm ~1 MB). Imagens de posts privados não exigem login pra abrir, mas o endereço delas é aleatório e só aparece pra quem vê o post.
- O backup JSON não leva os usuários do painel nem as imagens.

---

## Testar o Worker sem publicar

Precisa só do Node.js 20 ou mais novo:

```powershell
node worker/test.mjs
```

Ele simula o KV, o captcha e o Discord, e confere as regras de segurança: captcha, links, limite por IP, permissão de cada cargo, troca de senha obrigatória, sessão derrubada e bloqueio de login.

## Idiomas do site

O site público tem português, inglês e espanhol (bandeiras no topo). O painel fica só em português. As traduções estão em `site/i18n.js`, uma linha por texto: `['texto em português', 'inglês', 'espanhol']`. O que vocês escrevem pelo painel (regras, avisos, táticas, nomes de squads) aparece como foi escrito, sem tradução.

## Resultados / KDA com leitura de print (Workers AI)

O botão **Ler prints com IA** usa o Workers AI da Cloudflare, que tem uma cota grátis por dia. Se a cota acabar ou a IA não entender a print, a tabela aparece vazia pra preencher na mão.

**Como ativar:**
- **Pelo `wrangler.toml`** (já vem pronto neste projeto): as linhas `[ai]` e `binding = "AI"`. É só publicar de novo com `npx wrangler deploy`.
- **Pelo painel da Cloudflare:** Worker → **Settings → Bindings → Add → Workers AI**, com o nome `AI` (em maiúsculas).

Na primeira leitura, o Worker aceita sozinho a licença do modelo de visão (Llama 3.2). As prints do placar somem em 7 dias; os números salvos ficam pra sempre.

**Dica:** tire a print **só do placar**, sem o resto da tela. A leitura fica bem mais certa.

## Primeiro acesso: crie a season atual

Entre como superadmin, vá em **Config → Seasons → Adicionar season**, confira o nome e as datas (mais ou menos 1 mês), marque **Atual** e clique em **Salvar config**. Presença, resultados e gear passam a guardar a season. O que já existia antes é encaixado na season pela data.

## Secrets opcionais do Discord

Configure igual aos outros (`npx wrangler secret put NOME` ou pelo painel da Cloudflare). Sem eles, nada quebra.

| Nome | Pra quê |
|---|---|
| `DISCORD_BACKUP_WEBHOOK` | Webhook de um canal **privado** que recebe o backup semanal. |
| `DISCORD_RESULTS_WEBHOOK` | Webhook separado pra KD e presença. Sem ele, vão pro webhook principal (o da aba Discord). |

O que é postado sozinho (registro, gear, apply, KD do game, KD do dia, presença, tática) liga e desliga na aba **Discord** do painel. A presença vai só com os nomes, nunca com a justificativa.

## Backup semanal automático

Todo domingo às 06:00 UTC (03:00 em Brasília; no `wrangler.toml` fica `0 6 * * SUN`), o Worker gera o mesmo JSON do backup manual (sem imagens e sem usuários do painel) e manda como arquivo pro `DISCORD_BACKUP_WEBHOOK`. O horário fica em `wrangler.toml`, em `[triggers]`. Pra conferir na hora, use **Config → Testar backup agora** (só superadmin). Sem o secret, o backup não é enviado.

## Limites de tamanho das imagens

- **No navegador:** a print é reduzida pra no máximo 1920px no lado maior e comprimida até uns 800 KB. Arquivos acima de 15 MB são recusados antes de tudo.
- **No Worker** (vale mesmo se alguém burlar o navegador): no máximo 1 MB por imagem, 5 MB somando o envio, 4096px de cada lado, 4 imagens por envio e 8 por post de tática ou aviso. Os valores ficam no topo do `worker/worker.js`.
- **Prints de gear:** quando o membro manda um gear novo com prints, as prints das atualizações anteriores somem em 60 dias. O texto e o tipo de gear ficam pra sempre; as prints da última atualização ficam sem prazo.
