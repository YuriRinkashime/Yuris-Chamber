import express from 'express';
import crypto from 'crypto';
import { getAiConfig, saveAiConfig } from './services/aiService.js';
import {
  formatUptime,
  getBotStartedAt,
  isMaintenanceModeRuntime,
  getMaintenanceMessage,
  saveRuntimeSettings,
  loadRuntimeSettings,
} from './services/runtimeSettings.js';
import {
  getCommandAccessSnapshot,
  disableCommand,
  enableCommand,
  isProtectedCommand,
} from './services/commandAccessService.js';
import { getGuildConfig } from './services/config/guildConfig.js';
import { getLogs, pushLog } from './utils/logBuffer.js';
import { logger } from './utils/logger.js';

const app = express();
const port = process.env.PORT || process.env.SERVER_PORT || 3000;
const host = '0.0.0.0';

let discordClient = null;

const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DEFAULT_GUILD_ID = process.env.GUILD_ID || '';
const BASE = normalizeBase(process.env.DASHBOARD_BASE || '');

const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function normalizeBase(b) {
  if (!b || b === '/') return '';
  return '/' + String(b).replace(/^\/+|\/+$/g, '');
}
function path(p) {
  return `${BASE}${p.startsWith('/') ? p : `/${p}`}`;
}
function signToken() {
  return crypto.randomBytes(24).toString('hex');
}
function createSession() {
  const token = signToken();
  sessions.set(token, {
    expiresAt: Date.now() + SESSION_TTL_MS,
    guildId: DEFAULT_GUILD_ID || null,
  });
  return token;
}
function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const p = part.trim();
    const i = p.indexOf('=');
    if (i === -1) continue;
    if (p.slice(0, i) === name) return decodeURIComponent(p.slice(i + 1));
  }
  return null;
}
function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `yuri_dash=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'yuri_dash=; Path=/; HttpOnly; Max-Age=0');
}
function requireAuth(req, res, next) {
  if (!isValidSession(getCookie(req, 'yuri_dash'))) {
    return res.redirect(path('/login'));
  }
  next();
}
function getSessionGuildId(req) {
  const token = getCookie(req, 'yuri_dash');
  const s = sessions.get(token);
  return s?.guildId || DEFAULT_GUILD_ID || '';
}
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function guildSelectHtml(selected) {
  if (!discordClient) return '<option value="">Bot offline</option>';
  return [...discordClient.guilds.cache.values()]
    .map(
      (g) =>
        `<option value="${g.id}" ${g.id === selected ? 'selected' : ''}>${escapeHtml(g.name)}</option>`,
    )
    .join('');
}

function layout(title, body, active = '') {
  const nav = [
    ['dashboard', 'Overview', path('/dashboard')],
    ['ai', 'AI', path('/dashboard/ai')],
    ['commands', 'Commands', path('/dashboard/commands')],
    ['dms', 'DMs', path('/dashboard/dms')],
    ['maintenance', 'Maintenance', path('/dashboard/maintenance')],
  ]
    .map(
      ([id, label, href]) =>
        `<a class="nav-link${active === id ? ' active' : ''}" href="${href}">${label}</a>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} · Yuri's Chamber</title>
<style>
:root{
  --bg:#07060a;--panel:#12101a;--panel2:#1a1625;--border:rgba(212,175,255,.14);
  --text:#f4f0ff;--muted:#a89bb8;--accent:#c4a1ff;--good:#5ddea0;--bad:#ff6b7a;
  --glow:rgba(196,161,255,.35);--font:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:var(--font);color:var(--text);
background:radial-gradient(900px 500px at 10% -5%,rgba(196,161,255,.22),transparent 55%),radial-gradient(700px 400px at 100% 0%,rgba(255,107,157,.12),transparent 50%),var(--bg);background-attachment:fixed}
a{color:inherit;text-decoration:none}
.shell{max-width:720px;margin:0 auto;padding:24px 16px 56px}
.hero{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.avatar{width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#2a2038,var(--panel2));border:1px solid var(--border);box-shadow:0 0 24px var(--glow);display:grid;place-items:center;font-size:22px}
.brand{font-size:20px;font-weight:700}.brand span{display:block;font-size:12px;font-weight:500;color:var(--muted);margin-top:2px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.nav{display:flex;gap:6px;flex-wrap:wrap}
.nav-link{padding:8px 14px;border-radius:999px;font-size:13px;font-weight:500;color:var(--muted);border:1px solid transparent}
.nav-link:hover{color:var(--text);border-color:var(--border)}
.nav-link.active{color:#120818;background:linear-gradient(135deg,var(--accent),#e0c4ff);font-weight:600}
.card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--border);border-radius:18px;padding:18px;margin-bottom:12px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
h1{margin:0 0 14px;font-size:22px}h2{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
label{display:block;margin:12px 0 6px;font-size:13px;color:var(--muted)}
input[type=text],input[type=password],textarea,select{width:100%;padding:12px 14px;border-radius:12px;font:inherit;font-size:15px;color:var(--text);background:rgba(0,0,0,.35);border:1px solid var(--border);outline:none}
textarea{min-height:120px;resize:vertical}
.btn{display:inline-flex;align-items:center;gap:6px;border:none;cursor:pointer;font:inherit;font-size:14px;font-weight:600;padding:10px 16px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#a78bfa);color:#120818}
.btn.secondary{background:rgba(255,255,255,.04);color:var(--text);border:1px solid var(--border)}
.btn.danger{background:linear-gradient(135deg,#ff6b7a,#c23a4a);color:#fff}
.btn.good{background:linear-gradient(135deg,#5ddea0,#2a9d6a);color:#04140c}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
.muted{color:var(--muted);font-size:13px;line-height:1.4}.err{color:var(--bad)}.ok{color:var(--good)}
.stat{font-size:20px;font-weight:700}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
.badge.on{background:rgba(93,222,160,.15);color:var(--good)}
.badge.off{background:rgba(255,107,122,.15);color:var(--bad)}
.grid{display:grid;gap:12px}@media(min-width:640px){.grid-2{grid-template-columns:1fr 1fr}}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:10px 6px;border-bottom:1px solid var(--border);text-align:left}
th{color:var(--muted);font-size:11px;text-transform:uppercase}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.login-card{width:min(400px,100%)}.login-card .avatar{margin:0 auto 12px}.login-card .brand{text-align:center;margin-bottom:18px}
input[type=checkbox]{width:18px;height:18px;accent-color:var(--accent)}
</style>
</head>
<body>
${
  active
    ? `<div class="shell">
  <div class="hero"><div class="avatar">◈</div><div class="brand">Yuri's Chamber<span>BANORANT control panel</span></div></div>
  <div class="top"><nav class="nav">${nav}</nav>
  <form method="POST" action="${path('/logout')}" style="margin:0"><button class="btn secondary" type="submit">Log out</button></form></div>
  ${body}</div>`
    : `<div class="login-wrap"><div class="card login-card"><div class="avatar">◈</div><div class="brand">Yuri's Chamber<span>Dashboard login</span></div>${body}</div></div>`
}
</body></html>`;
}

app.get('/health', (req, res) => res.json({ status: 'healthy' }));
app.get('/ready', (req, res) => {
  res.json({
    ready: true,
    bot: Boolean(discordClient?.user),
    uptime: formatUptime(),
    maintenance: isMaintenanceModeRuntime(),
  });
});
app.get('/', (req, res) => res.redirect(path('/login')));
if (BASE) app.get(BASE, (req, res) => res.redirect(path('/login')));

app.get(path('/api/live'), requireAuth, async (req, res) => {
  const user = discordClient?.user;
  let presenceText = '';
  try {
    const act = user?.presence?.activities?.[0];
    if (act) presenceText = act.type === 4 ? act.state || act.name || '' : act.name || '';
  } catch (_) {}
  let saved = null;
  try {
    saved = await discordClient?.db?.get('bot:presence', null);
  } catch (_) {}
  res.json({
    ok: true,
    bot: {
      tag: user?.tag || null,
      ready: Boolean(user),
      ping: discordClient?.ws?.ping ?? null,
      guilds: discordClient?.guilds?.cache?.size ?? 0,
      commands: discordClient?.commands?.size ?? 0,
      uptime: formatUptime(Date.now() - getBotStartedAt()),
      maintenance: isMaintenanceModeRuntime(),
      presence: presenceText || saved?.text || '',
    },
    logs: getLogs(40),
  });
});

app.get(path('/api/dms'), requireAuth, async (req, res) => {
  try {
    const { listInbox } = await import('./services/dmInboxService.js');
    const threads = await listInbox(discordClient);
    res.json({
      ok: true,
      threads: (threads || []).map((t) => ({
        userId: t.userId,
        userTag: t.userTag || t.userId,
        status: t.status || 'open',
        messages: (t.messages || []).slice(-10),
        autoAiAt: t.autoAiAt || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get(path('/login'), (req, res) => {
  if (isValidSession(getCookie(req, 'yuri_dash'))) return res.redirect(path('/dashboard'));
  let err = '';
  if (req.query.error === '1') err = '<p class="err">Wrong username or password.</p>';
  if (req.query.error === 'config') err = '<p class="err">Login is not configured.</p>';
  res.send(
    layout(
      'Login',
      `${err}
      <form method="POST" action="${path('/login')}">
        <label>Username</label>
        <input type="text" name="username" required autocomplete="username"/>
        <label>Password</label>
        <input type="password" name="password" required autocomplete="current-password"/>
        <div class="row"><button class="btn" type="submit">Log in</button></div>
      </form>`,
      '',
    ),
  );
});

app.post(path('/login'), (req, res) => {
  if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) {
    return res.redirect(path('/login') + '?error=config');
  }
  const username = String(req.body.username || '');
  const password = String(req.body.password || '');
  const userOk = username === DASHBOARD_USERNAME;
  const a = Buffer.from(password);
  const b = Buffer.from(DASHBOARD_PASSWORD);
  const passOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!userOk || !passOk) return res.redirect(path('/login') + '?error=1');
  setSessionCookie(res, createSession());
  res.redirect(path('/dashboard'));
});

app.post(path('/logout'), requireAuth, (req, res) => {
  const t = getCookie(req, 'yuri_dash');
  if (t) sessions.delete(t);
  clearSessionCookie(res);
  res.redirect(path('/login'));
});

app.post(path('/dashboard/guild'), requireAuth, (req, res) => {
  const token = getCookie(req, 'yuri_dash');
  const s = sessions.get(token);
  const gid = String(req.body.guildId || '');
  if (s && discordClient?.guilds?.cache?.has(gid)) s.guildId = gid;
  res.redirect(path('/dashboard/commands'));
});

app.get(path('/dashboard'), requireAuth, async (req, res) => {
  res.send(
    layout(
      'Overview',
      `<h1>Overview</h1>
      <div class="grid grid-2">
        <div class="card">
          <h2>Live status</h2>
          <p class="stat" id="live-tag">…</p>
          <p class="muted">Uptime <strong id="live-uptime">—</strong></p>
          <p class="muted">Ping <strong id="live-ping">—</strong> ms · Guilds <strong id="live-guilds">—</strong></p>
          <p class="muted">Commands <strong id="live-cmds">—</strong></p>
          <p class="muted">Presence <strong id="live-presence">—</strong></p>
          <p>Maintenance <span id="live-maint" class="badge">—</span></p>
        </div>
        <div class="card">
          <h2>Quick links</h2>
          <div class="row">
            <a class="btn" href="${path('/dashboard/ai')}">AI</a>
            <a class="btn secondary" href="${path('/dashboard/commands')}">Commands</a>
            <a class="btn secondary" href="${path('/dashboard/dms')}">DMs</a>
            <a class="btn secondary" href="${path('/dashboard/maintenance')}">Maintenance</a>
          </div>
          <p class="muted" style="margin-top:12px">Auto-refreshes every 3s</p>
        </div>
      </div>
            <div class="card">
        <h2>Recent logs</h2>
        <style>
          #live-logs{
            margin:0;max-height:280px;overflow:auto;font-size:12px;line-height:1.4;
            white-space:pre-wrap;color:var(--muted);padding-right:4px;
            scrollbar-width:thin;scrollbar-color:rgba(196,161,255,.35) transparent;
          }
          #live-logs::-webkit-scrollbar{width:6px}
          #live-logs::-webkit-scrollbar-track{background:transparent}
          #live-logs::-webkit-scrollbar-thumb{background:rgba(196,161,255,.35);border-radius:99px}
          #live-logs::-webkit-scrollbar-thumb:hover{background:rgba(196,161,255,.55)}
        </style>
        <pre id="live-logs"></pre>
      </div>
      <script>
      const base = ${JSON.stringify(path('/api/live'))};
      async function tick() {
        try {
          const r = await fetch(base, { credentials: 'same-origin' });
          if (!r.ok) return;
          const d = await r.json();
          const b = d.bot || {};
          document.getElementById('live-tag').textContent = b.tag || 'offline';
          document.getElementById('live-uptime').textContent = b.uptime || '—';
          document.getElementById('live-ping').textContent = b.ping ?? '—';
          document.getElementById('live-guilds').textContent = b.guilds ?? '—';
          document.getElementById('live-cmds').textContent = b.commands ?? '—';
          document.getElementById('live-presence').textContent = b.presence || '(none)';
          const m = document.getElementById('live-maint');
          m.textContent = b.maintenance ? 'ON' : 'OFF';
          m.className = 'badge ' + (b.maintenance ? 'off' : 'on');
          document.getElementById('live-logs').textContent = (d.logs || []).map(function(l) {
            return '[' + new Date(l.t).toLocaleTimeString() + '] ' + l.level + ': ' + l.message;
          }).join('\\n') || 'No logs yet';
        } catch (e) {}
      }
      tick(); setInterval(tick, 3000);
      </script>`,
      'dashboard',
    ),
  );
});

app.get(path('/dashboard/ai'), requireAuth, async (req, res) => {
  const guildId = getSessionGuildId(req);
  if (!discordClient?.db || !guildId) {
    return res.send(layout('AI', '<p class="err">DB or guild missing.</p>', 'ai'));
  }
  const config = await getAiConfig(discordClient, guildId);
  const saved = req.query.saved ? '<p class="ok">Saved.</p>' : '';
  res.send(
    layout(
      'AI',
      `<h1>AI settings</h1>${saved}
      <div class="card">
        <form method="POST" action="${path('/dashboard/ai')}">
          <label class="row"><input type="checkbox" name="enabled" value="1" ${config.enabled ? 'checked' : ''}/> Enabled</label>
          <label>Custom instructions</label>
          <textarea name="systemInstructions" maxlength="4000">${escapeHtml(config.systemInstructions)}</textarea>
          <label>Model</label>
          <input type="text" name="model" value="${escapeHtml(config.model)}"/>
          <div class="row"><button class="btn" type="submit">Save</button></div>
        </form>
      </div>`,
      'ai',
    ),
  );
});

app.post(path('/dashboard/ai'), requireAuth, async (req, res) => {
  const guildId = getSessionGuildId(req);
  await saveAiConfig(discordClient, guildId, {
    enabled: req.body.enabled === '1',
    systemInstructions: String(req.body.systemInstructions || '').slice(0, 4000),
    model: String(req.body.model || 'llama-3.3-70b-instruct:free').slice(0, 120),
  });
  res.redirect(path('/dashboard/ai') + '?saved=1');
});

app.get(path('/dashboard/maintenance'), requireAuth, async (req, res) => {
  const guildId = getSessionGuildId(req);
  if (guildId && discordClient) await loadRuntimeSettings(discordClient, guildId);
  const on = isMaintenanceModeRuntime();
  const msg = getMaintenanceMessage();
  const saved = req.query.saved ? '<p class="ok">Saved.</p>' : '';
  res.send(
    layout(
      'Maintenance',
      `<h1>Maintenance</h1>${saved}
      <div class="card">
        <form method="POST" action="${path('/dashboard/maintenance')}">
          <label class="row"><input type="checkbox" name="maintenanceMode" value="1" ${on ? 'checked' : ''}/> Maintenance mode</label>
          <label>Message</label>
          <textarea name="maintenanceMessage" maxlength="500">${escapeHtml(msg)}</textarea>
          <div class="row"><button class="btn ${on ? 'danger' : 'good'}" type="submit">Save</button></div>
        </form>
      </div>`,
      'maintenance',
    ),
  );
});

app.post(path('/dashboard/maintenance'), requireAuth, async (req, res) => {
  await saveRuntimeSettings(discordClient, getSessionGuildId(req), {
    maintenanceMode: req.body.maintenanceMode === '1',
    maintenanceMessage: String(req.body.maintenanceMessage || '').slice(0, 500),
  });
  res.redirect(path('/dashboard/maintenance') + '?saved=1');
});

app.get(path('/dashboard/commands'), requireAuth, async (req, res) => {
  if (!discordClient?.commands) {
    return res.send(layout('Commands', '<p class="err">Bot not ready.</p>', 'commands'));
  }
  const guildId = getSessionGuildId(req);
  if (!guildId) {
    return res.send(layout('Commands', '<p class="err">No guild selected.</p>', 'commands'));
  }
  const config = await getGuildConfig(discordClient, guildId);
  const snap = getCommandAccessSnapshot(discordClient, config);
  const flash = req.query.ok
    ? `<p class="ok">${escapeHtml(req.query.ok)}</p>`
    : req.query.err
      ? `<p class="err">${escapeHtml(req.query.err)}</p>`
      : '';
  const switcher = `<div class="card"><h2>Server</h2>
    <form method="POST" action="${path('/dashboard/guild')}" class="row">
      <select name="guildId" style="flex:1">${guildSelectHtml(guildId)}</select>
      <button class="btn secondary" type="submit">Switch</button>
    </form></div>`;
  let tables = '';
  for (const cat of snap.categories || []) {
    const rows = (cat.commands || [])
      .filter((c) => !c.isSubcommand)
      .map((c) => {
        const enabled = !snap.disabledCommands?.[c.name.toLowerCase()];
        const protectedCmd = c.protected || isProtectedCommand(c.name);
        const toggle = protectedCmd
          ? '<span class="muted">protected</span>'
          : `<form method="POST" action="${path('/dashboard/commands/toggle')}" style="margin:0">
              <input type="hidden" name="command" value="${escapeHtml(c.name)}"/>
              <input type="hidden" name="enable" value="${enabled ? '0' : '1'}"/>
              <button class="btn ${enabled ? 'danger' : 'good'}" type="submit" style="padding:4px 10px;font-size:12px">${enabled ? 'Off' : 'On'}</button>
            </form>`;
        return `<tr><td><code>${escapeHtml(c.name)}</code></td>
          <td class="muted">${escapeHtml(c.description || '').slice(0, 60)}</td>
          <td>${enabled ? '<span class="badge on">ON</span>' : '<span class="badge off">OFF</span>'}</td>
          <td>${toggle}</td></tr>`;
      })
      .join('');
    tables += `<div class="card"><h2>${escapeHtml(cat.displayName || 'Category')}</h2>
      <table><thead><tr><th>Cmd</th><th>Desc</th><th>State</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">None</td></tr>'}</tbody></table></div>`;
  }
  res.send(layout('Commands', `<h1>Commands</h1>${flash}${switcher}${tables}`, 'commands'));
});

app.post(path('/dashboard/commands/toggle'), requireAuth, async (req, res) => {
  const guildId = getSessionGuildId(req);
  const name = String(req.body.command || '');
  const enable = req.body.enable === '1';
  try {
    if (enable) await enableCommand(discordClient, guildId, name);
    else await disableCommand(discordClient, guildId, name);
    res.redirect(path('/dashboard/commands') + `?ok=${encodeURIComponent((enable ? 'Enabled ' : 'Disabled ') + name)}`);
  } catch (e) {
    res.redirect(path('/dashboard/commands') + `?err=${encodeURIComponent(e.message)}`);
  }
});

app.get(path('/dashboard/dms'), requireAuth, async (req, res) => {
  res.send(
    layout(
      'DMs',
      `<h1>Bot DMs</h1>
      <p class="muted" id="dm-flash"></p>
      <p class="muted">Live · no page reload</p>
      <div id="dm-list"><p class="muted">Loading…</p></div>
      <style>
        .dm-card{margin-bottom:14px}
        .dm-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
        .dm-head h2{margin:0;font-size:16px;text-transform:none;letter-spacing:0;color:var(--text)}
        .dm-thread{
          display:flex;flex-direction:column;gap:8px;
          max-height:280px;overflow:auto;padding:6px 4px 8px 2px;
        }
        .dm-thread{scrollbar-width:thin;scrollbar-color:rgba(196,161,255,.35) transparent}
        .dm-thread::-webkit-scrollbar{width:6px}
        .dm-thread::-webkit-scrollbar-track{background:transparent}
        .dm-thread::-webkit-scrollbar-thumb{background:rgba(196,161,255,.35);border-radius:99px}
        .dm-thread::-webkit-scrollbar-thumb:hover{background:rgba(196,161,255,.55)}
        .bubble{max-width:92%;padding:10px 12px;border-radius:14px;font-size:13px;line-height:1.4;word-break:break-word}
        .bubble.user{align-self:flex-start;background:rgba(255,255,255,.06);border:1px solid var(--border)}
        .bubble.owner{align-self:flex-end;background:rgba(196,161,255,.18);border:1px solid rgba(196,161,255,.35)}
        .bubble.ai{align-self:flex-end;background:rgba(93,222,160,.12);border:1px solid rgba(93,222,160,.3)}
        .bubble .who{font-size:11px;color:var(--muted);margin-bottom:4px;font-weight:600}
        .dm-actions textarea{min-height:72px}
        .dm-actions .btn:disabled{opacity:.5;cursor:wait}
      </style>
      <script>
      const api = ${JSON.stringify(path('/api/dms'))};
      const replyUrl = ${JSON.stringify(path('/dashboard/dms/reply'))};

      const scrollMap = {};
      let activeUserId = null;
      const draftMap = {};

      function esc(s){
        return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
      function roleClass(from){
        if(from==='user') return 'user';
        if(from==='ai') return 'ai';
        return 'owner';
      }
      function roleLabel(from){
        if(from==='user') return 'User';
        if(from==='ai') return 'AI';
        return 'You';
      }
      function flash(msg, isErr){
        const el = document.getElementById('dm-flash');
        el.textContent = msg || '';
        el.className = isErr ? 'err' : 'ok';
        if(msg) setTimeout(function(){ el.textContent=''; }, 4000);
      }

      function saveScrollState(){
        document.querySelectorAll('.dm-thread[data-uid]').forEach(function(el){
          scrollMap[el.getAttribute('data-uid')] = el.scrollTop;
        });
        document.querySelectorAll('textarea[data-uid]').forEach(function(el){
          draftMap[el.getAttribute('data-uid')] = el.value;
          if(document.activeElement === el) activeUserId = el.getAttribute('data-uid');
        });
      }

      function restoreScrollState(){
        document.querySelectorAll('.dm-thread[data-uid]').forEach(function(el){
          const uid = el.getAttribute('data-uid');
          if(scrollMap[uid] != null) el.scrollTop = scrollMap[uid];
          else el.scrollTop = el.scrollHeight;
        });
        document.querySelectorAll('textarea[data-uid]').forEach(function(el){
          const uid = el.getAttribute('data-uid');
          if(draftMap[uid] != null) el.value = draftMap[uid];
          if(uid === activeUserId){
            el.focus();
            try{ const n = el.value.length; el.setSelectionRange(n,n); }catch(e){}
          }
        });
      }

      function render(threads){
        saveScrollState();
        const box = document.getElementById('dm-list');
        if(!threads.length){
          box.innerHTML = '<p class="muted">No DMs yet.</p>';
          return;
        }
        box.innerHTML = threads.map(function(t){
          const hist = (t.messages||[]).map(function(m){
            return '<div class="bubble '+roleClass(m.from)+'">'+
              '<div class="who">'+esc(roleLabel(m.from))+'</div>'+
              esc(m.content)+
            '</div>';
          }).join('');
          let timer = '';
          if(t.autoAiAt && t.status==='waiting_owner'){
            const left = Math.max(0, Math.floor((t.autoAiAt - Date.now())/1000));
            timer = '<span class="badge off">Auto-AI '+Math.floor(left/60)+'m '+(left%60)+'s</span>';
          } else {
            timer = '<span class="badge on">'+esc(t.status||'open')+'</span>';
          }
          return '<div class="card dm-card" data-card="'+esc(t.userId)+'">'+
            '<div class="dm-head"><h2>'+esc(t.userTag)+'</h2>'+timer+'</div>'+
            '<div class="dm-thread" data-uid="'+esc(t.userId)+'">'+hist+'</div>'+
            '<div class="dm-actions">'+
              '<textarea data-uid="'+esc(t.userId)+'" placeholder="Type your reply…"></textarea>'+
              '<div class="row">'+
                '<button type="button" class="btn" data-send="human" data-uid="'+esc(t.userId)+'">Send my words</button>'+
                '<button type="button" class="btn secondary" data-send="ai" data-uid="'+esc(t.userId)+'">AI reply</button>'+
              '</div>'+
            '</div>'+
          '</div>';
        }).join('');
        restoreScrollState();
        bindSendButtons();
      }

      async function sendReply(userId, mode){
        const ta = document.querySelector('textarea[data-uid="'+userId+'"]');
        const content = ta ? ta.value.trim() : '';
        if(mode === 'human' && !content){
          flash('Type a message first', true);
          return;
        }
        const buttons = document.querySelectorAll('button[data-uid="'+userId+'"]');
        buttons.forEach(function(b){ b.disabled = true; });

        try{
          const body = new URLSearchParams();
          body.set('userId', userId);
          body.set('mode', mode);
          body.set('content', content);

          const r = await fetch(replyUrl, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json',
            },
            body: body.toString(),
          });

          const data = await r.json().catch(function(){ return {}; });
          if(!r.ok || data.ok === false){
            flash(data.error || 'Send failed', true);
          } else {
            flash(data.message || 'Sent');
            if(ta) ta.value = '';
            draftMap[userId] = '';
            // stick to bottom after your reply
            scrollMap[userId] = 999999;
          }
          await tick();
        } catch(e){
          flash('Network error', true);
        } finally {
          buttons.forEach(function(b){ b.disabled = false; });
        }
      }

      function bindSendButtons(){
        document.querySelectorAll('button[data-send]').forEach(function(btn){
          btn.onclick = function(){
            sendReply(btn.getAttribute('data-uid'), btn.getAttribute('data-send'));
          };
        });
      }

      async function tick(){
        try{
          const r = await fetch(api, { credentials:'same-origin' });
          if(!r.ok) return;
          const d = await r.json();
          render(d.threads||[]);
        }catch(e){}
      }
      tick();
      setInterval(tick, 3000);
      </script>`,
      'dms',
    ),
  );
});

app.post(path('/dashboard/dms/reply'), requireAuth, async (req, res) => {
  const wantsJson =
    (req.headers.accept || '').includes('application/json') ||
    req.headers['x-requested-with'] === 'XMLHttpRequest';

  try {
    const userId = String(req.body.userId || '');
    const mode = String(req.body.mode || 'human');
    const content = String(req.body.content || '').trim();
    const {
      appendBotDm,
      getThread,
      cancelAutoAi,
      updateOwnerNotify,
    } = await import('./services/dmInboxService.js');
    const {
      getAiConfig,
      generateReply,
      buildSystemInstructions,
    } = await import('./services/aiService.js');

    await cancelAutoAi(userId);

    const user = await discordClient.users.fetch(userId);
    let text = content;

    if (mode === 'ai') {
      const guildId = getSessionGuildId(req) || DEFAULT_GUILD_ID;
      const config = await getAiConfig(discordClient, guildId);
      const thread = await getThread(discordClient, userId);
      const lastUser = [...(thread.messages || [])]
        .reverse()
        .find((m) => m.from === 'user');
      const userMessage = lastUser?.content || content || 'Hello';

      text = await generateReply({
        systemInstructions: await buildSystemInstructions(
          discordClient,
          guildId,
          userId,
          (config.systemInstructions || '') + '\n\nPrivate DM as Yuri. Short.',
        ),
        userMessage,
        model: config.model,
        history: [],
      });
      if (text.length > 1800) text = text.slice(0, 1800) + '...';
    }

    if (!text) {
      if (wantsJson) return res.status(400).json({ ok: false, error: 'Empty message' });
      return res.redirect(path('/dashboard/dms') + '?err=Empty+message');
    }

    await user.send({ content: text });
    await appendBotDm(discordClient, userId, text, mode === 'ai' ? 'ai' : 'owner');

    // >>> THIS updates your Discord card
    await updateOwnerNotify(discordClient, userId, {
      lastSent: text,
      footer: mode === 'ai' ? '🤖 AI reply sent (dashboard)' : '✍️ Your reply sent (dashboard)',
      disableButtons: false,
    });

    if (wantsJson) {
      return res.json({ ok: true, message: 'Sent to ' + user.tag });
    }
    res.redirect(path('/dashboard/dms') + `?ok=${encodeURIComponent('Sent to ' + user.tag)}`);
  } catch (e) {
    if (wantsJson) return res.status(500).json({ ok: false, error: e.message });
    res.redirect(path('/dashboard/dms') + `?err=${encodeURIComponent(e.message)}`);
  }
});

export function startServer(client) {
  discordClient = client || null;
  if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) {
    logger.warn('Dashboard login env not set');
  }
  try {
    pushLog('info', 'Dashboard starting');
  } catch (_) {}
  app.listen(port, host, () => {
    logger.info(`[Chamber] Web on ${host}:${port}`);
  });
}
