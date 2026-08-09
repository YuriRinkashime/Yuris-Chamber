import express from 'express';
import crypto from 'crypto';
import { getAiConfig, saveAiConfig } from './services/aiService.js';
import {
  listActivePolls,
  listEndedPolls,
  getPollStats,
  deletePoll,
  endPoll,
  applyPollEdit,
  getPoll,
} from './services/pollService.js';
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
const presenceCache = { data: null, at: 0 };
const PRESENCE_TTL = 60_000;

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
    ['dashboard', 'Overview', '◆', path('/dashboard')],
    ['ai', 'AI', '✦', path('/dashboard/ai')],
    ['commands', 'Commands', '▣', path('/dashboard/commands')],
    ['dms', 'DMs', '✉', path('/dashboard/dms')],
    ['polls', 'Polls', '📊', path('/dashboard/polls')],
    ['maintenance', 'Maintenance', '⚙', path('/dashboard/maintenance')],
  ]
    .map(
      ([id, label, icon, href]) =>
        `<a class="nav-link${active === id ? ' active' : ''}" href="${href}"><span class="nav-ico">${icon}</span>${label}</a>`,
    )
    .join('');

  const isLogin = active === 'login';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} · Yuri's Chamber</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg:#0b0e13;
  --bg2:#11151c;
  --panel:#151a22;
  --panel2:#1a212c;
  --line:rgba(236,232,225,.12);
  --text:#ece8e1;
  --muted:#8b978f;
  --val:#ff4655;
  --val2:#0fdda3;
  --gold:#f0c75e;
  --chamber-blue:#3d5a80;
  --chamber-navy:#1b2838;
  --glow:rgba(255,70,85,.35);
  --font:'IBM Plex Sans',system-ui,sans-serif;
  --display:'Rajdhani',system-ui,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  font-family:var(--font);color:var(--text);background:var(--bg);
  ${isLogin ? 'overflow:hidden;height:100vh;' : 'min-height:100vh;'}
}
/* Valorant-ish geometric backdrop (no external images required) */
body::before{
  content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(ellipse 70% 50% at 80% -10%,rgba(255,70,85,.18),transparent 55%),
    radial-gradient(ellipse 50% 40% at -10% 80%,rgba(15,221,163,.08),transparent 50%),
    linear-gradient(135deg,transparent 40%,rgba(255,70,85,.03) 40%,rgba(255,70,85,.03) 41%,transparent 41%),
    repeating-linear-gradient(-18deg,transparent,transparent 80px,rgba(236,232,225,.02) 80px,rgba(236,232,225,.02) 81px),
    var(--bg);
}
body::after{
  content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:
    linear-gradient(rgba(255,70,85,.04) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,70,85,.04) 1px,transparent 1px);
  background-size:48px 48px;opacity:.4;
  mask-image:radial-gradient(ellipse at center,black 20%,transparent 75%);
}
a{color:inherit;text-decoration:none}
.shell{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:22px 16px 40px;overflow-x:hidden;width:100%;box-sizing:border-box}
${isLogin ? '.shell{max-width:100%;height:100vh;padding:0;display:flex;flex-direction:column}' : ''}

.hero{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.avatar{
  width:52px;height:52px;border-radius:4px;
  background:linear-gradient(145deg,#2a1014,var(--panel2));
  border:1px solid rgba(255,70,85,.35);
  box-shadow:0 0 20px var(--glow);
  display:grid;place-items:center;font-size:18px;color:var(--val);
  clip-path:polygon(0 0,100% 0,100% 70%,85% 100%,0 100%);
}
.brand{font-family:var(--display);font-size:26px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;line-height:1}
.brand span{display:block;font-family:var(--font);font-size:11px;font-weight:500;color:var(--muted);margin-top:4px;letter-spacing:.14em}

.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.nav{
  display:flex;gap:4px;flex-wrap:wrap;padding:4px;
  background:rgba(0,0,0,.35);border:1px solid var(--line);
  clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,12px 100%,0 calc(100% - 12px));
}
.nav-link{
  display:inline-flex;align-items:center;gap:6px;
  padding:10px 14px;font-family:var(--display);font-size:14px;font-weight:600;
  letter-spacing:.06em;text-transform:uppercase;color:var(--muted);
  transition:color .15s,background .15s;
}
.nav-link:hover{color:var(--text);background:rgba(255,70,85,.08)}
.nav-link.active{color:#fff;background:var(--val);box-shadow:0 0 16px var(--glow)}
.nav-ico{font-size:11px;opacity:.9}

.card{
  background:linear-gradient(180deg,var(--panel2),var(--panel));
  border:1px solid var(--line);padding:18px;margin-bottom:12px;
  clip-path:polygon(0 0,calc(100% - 16px) 0,100% 16px,100% 100%,16px 100%,0 calc(100% - 16px));
  box-shadow:0 12px 40px rgba(0,0,0,.45);
}
h1{margin:0 0 14px;font-family:var(--display);font-size:28px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
h2{margin:0 0 10px;font-family:var(--display);font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--val2);font-weight:600}
p{color:var(--muted);line-height:1.5;font-size:14px;margin:0 0 8px}
.ok{color:var(--val2)!important}.err{color:var(--val)!important}

label{display:block;font-size:11px;color:var(--muted);margin:12px 0 6px;font-family:var(--display);letter-spacing:.12em;text-transform:uppercase;font-weight:600}
input[type=text],input[type=password],textarea,select{
  width:100%;padding:12px 14px;border:1px solid var(--line);
  background:rgba(0,0,0,.4);color:var(--text);font:inherit;outline:none;
  border-radius:2px;
}
input:focus,textarea:focus,select:focus{border-color:var(--val);box-shadow:0 0 0 2px rgba(255,70,85,.2)}
textarea{min-height:200px;resize:vertical;line-height:1.5}

/* slim Valorant-style scrollbars */
*{scrollbar-width:thin;scrollbar-color:rgba(255,70,85,.5) rgba(0,0,0,.3)}
*::-webkit-scrollbar{width:6px;height:6px}
*::-webkit-scrollbar-track{background:rgba(0,0,0,.3)}
*::-webkit-scrollbar-thumb{background:rgba(255,70,85,.55);border-radius:2px}
*::-webkit-scrollbar-thumb:hover{background:rgba(255,70,85,.85)}

.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  padding:11px 20px;border:none;cursor:pointer;
  font-family:var(--display);font-size:14px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  background:var(--val);color:#fff;clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px));
  transition:filter .15s,transform .15s;
}
.btn:hover{filter:brightness(1.08);transform:translateY(-1px)}
.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--line);clip-path:none;border-radius:2px}
.btn.good{background:var(--val2);color:#041510}
.btn.danger{background:#b8323e}

.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.stat{padding:14px;background:rgba(0,0,0,.35);border:1px solid var(--line)}
.stat .v{font-family:var(--display);font-size:24px;font-weight:700;color:var(--val)}
.stat .k{font-size:10px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase;margin-top:2px}

#live-logs,pre.logs{
  max-height:240px;overflow:auto;padding:12px;margin:0;
  background:rgba(0,0,0,.5);border:1px solid var(--line);
  font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;color:#b8c4bc;
  white-space:pre-wrap;word-break:break-word;
}

/* command toggles */
.cmd-list{display:flex;flex-direction:column;gap:8px}
.cmd-row{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:12px 14px;background:rgba(0,0,0,.3);border:1px solid var(--line);
}
.cmd-row .name{font-family:var(--display);font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:15px}
.cmd-row .meta{font-size:11px;color:var(--muted)}
.cmd-row.on{border-left:3px solid var(--val2)}
.cmd-row.off{border-left:3px solid var(--val);opacity:.75}
.switch{
  position:relative;width:48px;height:26px;flex-shrink:0;
}
.switch input{opacity:0;width:0;height:0}
.switch .slider{
  position:absolute;cursor:pointer;inset:0;background:#333;transition:.2s;border-radius:2px;
}
.switch .slider:before{
  position:absolute;content:"";height:18px;width:18px;left:4px;bottom:4px;
  background:#fff;transition:.2s;border-radius:2px;
}
.switch input:checked + .slider{background:var(--val2)}
.switch input:checked + .slider:before{transform:translateX(20px)}
.switch input:not(:checked) + .slider{background:var(--val)}

.banner{
  height:100px;margin-bottom:14px;border:1px solid var(--line);
  background:
    linear-gradient(90deg,rgba(11,14,19,.92),rgba(11,14,19,.4)),
    linear-gradient(135deg,#1a0a0c 0%,#0b0e13 45%,#1b2838 100%);
  position:relative;overflow:hidden;
  clip-path:polygon(0 0,calc(100% - 20px) 0,100% 20px,100% 100%,0 100%);
}
.banner::before{
  content:"";position:absolute;right:-20px;top:-20px;width:160px;height:160px;
  border:2px solid rgba(255,70,85,.25);transform:rotate(18deg);
}
.banner .cap{
  position:absolute;left:18px;bottom:14px;
  font-family:var(--display);font-size:18px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
  color:var(--text);
}
.banner .cap small{display:block;font-size:11px;color:var(--muted);font-weight:500;margin-top:2px;letter-spacing:.16em}

/* login — no page scroll */
.login-screen{
  flex:1;display:flex;align-items:center;justify-content:center;
  padding:16px;min-height:0;overflow:hidden;
}
.login-card{
  width:min(380px,100%);padding:28px 24px;
  background:var(--panel);border:1px solid rgba(255,70,85,.25);
  box-shadow:0 0 40px rgba(255,70,85,.12),0 20px 50px rgba(0,0,0,.5);
  clip-path:polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,18px 100%,0 calc(100% - 18px));
}
.login-card .avatar{margin:0 auto 12px}
.login-card .brand{text-align:center;margin-bottom:18px}

.credits{
  margin-top:28px;padding:16px;border:1px solid var(--line);
  background:rgba(0,0,0,.25);font-size:12px;color:var(--muted);
  clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%);
}
.credits strong{color:var(--text);font-family:var(--display);letter-spacing:.08em;text-transform:uppercase}
.credits a{color:var(--val2);text-decoration:underline}

.footer-note{text-align:center;margin-top:20px;font-size:10px;color:var(--muted);letter-spacing:.14em;text-transform:uppercase;opacity:.65}

.toggle-row{display:flex;align-items:center;gap:10px;margin:8px 0}
.toggle-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--val)}

.flash{padding:10px 12px;margin-bottom:10px;border:1px solid var(--line);font-size:13px}
.flash.ok{border-color:rgba(15,221,163,.4);color:var(--val2)}
.flash.err{border-color:rgba(255,70,85,.4);color:var(--val)}

@media (max-width:640px){
  .brand{font-size:20px}
  h1{font-size:22px}
  .nav-link{padding:8px 10px;font-size:12px}
}

.muted{color:var(--muted)!important;font-size:13px}
.badge{display:inline-block;padding:3px 8px;font-family:var(--display);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.badge.on{background:rgba(15,221,163,.15);color:var(--val2);border:1px solid rgba(15,221,163,.35)}
.badge.off{background:rgba(255,70,85,.12);color:var(--val);border:1px solid rgba(255,70,85,.35)}
.grid{display:grid;gap:12px}
.grid-2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.switch-form{margin:0}
.intel{list-style:none;margin:0;padding:0}
.intel li{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;color:var(--muted)}
.intel li:last-child{border-bottom:none}
.intel .dot{width:8px;height:8px;margin-top:5px;flex-shrink:0;background:var(--val);box-shadow:0 0 8px var(--glow)}
.logs,#live-logs,.dm-thread,textarea{
  scrollbar-width:thin!important;
  scrollbar-color:rgba(255,70,85,.55) rgba(0,0,0,.3)!important;
}
.logs::-webkit-scrollbar,#live-logs::-webkit-scrollbar,.dm-thread::-webkit-scrollbar,textarea::-webkit-scrollbar{width:6px!important;height:6px!important}
.logs::-webkit-scrollbar-thumb,#live-logs::-webkit-scrollbar-thumb,.dm-thread::-webkit-scrollbar-thumb,textarea::-webkit-scrollbar-thumb{
  background:rgba(255,70,85,.55)!important;border-radius:2px!important;
}
.logs::-webkit-scrollbar-track,#live-logs::-webkit-scrollbar-track,.dm-thread::-webkit-scrollbar-track,textarea::-webkit-scrollbar-track{
  background:rgba(0,0,0,.3)!important;
}
</style>
</head>
<body class="${isLogin ? 'is-login' : ''}">
${
  isLogin
    ? `<div class="shell"><div class="login-screen"><div class="login-card">
        <div class="avatar">◆</div>
        <div class="brand">Yuri's Chamber<span>Enter the chamber</span></div>
        ${body}
       </div></div></div>`
    : `<div class="shell">
        <div class="hero"><div class="avatar">◆</div><div class="brand">Yuri's Chamber<span>BANORANT CAFE · control panel</span></div></div>
        <div class="top"><nav class="nav">${nav}</nav>
          <form method="POST" action="${path('/logout')}" style="margin:0"><button class="btn secondary" type="submit">Log out</button></form>
        </div>
        ${body}
        <div class="credits">
          <strong>Credits</strong><br/>
          Bot &amp; dashboard: <strong>Yuri Rinkashime (RinkaYuri)</strong> · BANORANT CAFE 🎮<br/>
          Runtime: Yuri's Chamber · Built for Filipino Valorant community<br/>
          Design inspired by VALORANT agent Chamber · Not affiliated with Riot Games
        </div>
        <p class="footer-note">Owner access only · sealed chamber</p>
      </div>`
}
</body>
</html>`;
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
    if (Date.now() - presenceCache.at < PRESENCE_TTL && presenceCache.data !== undefined) {
      saved = presenceCache.data;
    } else {
      saved = await discordClient?.db?.get('bot:presence', null);
      presenceCache.data = saved;
      presenceCache.at = Date.now();
    }
  } catch (_) {}
  let dbMode = 'unknown';
  try {
    if (!discordClient?.db) dbMode = 'offline';
    else if (typeof discordClient.db.isDegraded === 'function' && discordClient.db.isDegraded()) dbMode = 'degraded';
    else if (typeof discordClient.db.isAvailable === 'function' && discordClient.db.isAvailable()) dbMode = 'mongodb';
    else dbMode = 'connected';
  } catch (_) { dbMode = 'error'; }

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
      db: dbMode,
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
      'login',
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
  // Useful intel counts (best-effort)
  let levelUsers = 0;
  let activePolls = 0;
  let activeGw = 0;
  try {
    if (discordClient?.db?.list) {
      const keys = await discordClient.db.list('guild:');
      levelUsers = keys.filter((k) => k.includes(':leveling:users:')).length;
    }
    const ap = (await discordClient?.db?.get('polls:active', [])) || [];
    activePolls = Array.isArray(ap) ? ap.length : 0;
  } catch (_) {}

  let savedPresence = { text: '', typeName: 'Custom' };
  try {
    savedPresence = (await discordClient?.db?.get('bot:presence', null)) || savedPresence;
  } catch (_) {}

  const presenceSaved = req.query.presence === '1' ? '<p class="ok">Presence saved & applied.</p>' : '';

  res.send(
    layout(
      'Overview',
      `<h1>Overview</h1>
      ${presenceSaved}
      <div class="banner"><div class="cap">Status of the chamber<small>Live bot telemetry</small></div></div>
      <div class="grid grid-2">
        <div class="card">
          <h2>Live status</h2>
          <p class="stat" id="live-tag">…</p>
          <div class="stat-grid" style="margin-top:12px">
            <div class="stat"><div class="v" id="live-uptime">—</div><div class="k">Uptime</div></div>
            <div class="stat"><div class="v" id="live-ping">—</div><div class="k">Ping ms</div></div>
            <div class="stat"><div class="v" id="live-guilds">—</div><div class="k">Guilds</div></div>
            <div class="stat"><div class="v" id="live-cmds">—</div><div class="k">Commands</div></div>
          </div>
          <p class="muted" style="margin-top:12px">Live presence <strong id="live-presence">—</strong></p>
          <p>Maintenance <span id="live-maint" class="badge">—</span>
             · Database <span id="live-db" class="badge on">—</span></p>
        </div>
        <div class="card">
          <h2>Chamber intel</h2>
          <ul class="intel">
            <li><span class="dot"></span> Database: <strong>MongoDB</strong> · levels persist across restarts</li>
            <li><span class="dot"></span> Level profiles in DB: <strong>${levelUsers}</strong></li>
            <li><span class="dot"></span> Active polls: <strong>${activePolls}</strong></li>
            <li><span class="dot"></span> Guilds online: <strong id="intel-guilds">—</strong></li>
            <li><span class="dot"></span> Edit presence below · also /status in Discord</li>
            <li><span class="dot"></span> Polls & Giveaways tabs manage live events</li>
          </ul>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Bot presence (editable)</h2>
        <p class="muted">Shows as custom status / activity on the bot. Saved to MongoDB.</p>
        <form method="POST" action="${path('/dashboard/presence')}" class="row" style="flex-wrap:wrap;align-items:flex-end;gap:12px">
          <div style="flex:1;min-width:200px">
            <label class="muted" style="font-size:11px">Status text</label>
            <input type="text" name="text" maxlength="128" required
              value="${escapeHtml(savedPresence.text || '')}"
              placeholder="e.g. Status: grinding ranked with the cafe"/>
          </div>
          <div>
            <label class="muted" style="font-size:11px">Type</label>
            <select name="type">
              ${['Custom','Playing','Watching','Listening','Competing'].map((ty) =>
                `<option value="${ty}" ${ (savedPresence.typeName||'Custom')===ty ? 'selected' : ''}>${ty}</option>`
              ).join('')}
            </select>
          </div>
          <button class="btn" type="submit">Save presence</button>
        </form>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Recent logs</h2>
        <pre id="live-logs" class="muted" style="white-space:pre-wrap;max-height:180px;overflow:auto;font-size:12px">…</pre>
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
          var ig = document.getElementById('intel-guilds');
          if (ig) ig.textContent = b.guilds ?? '—';
          document.getElementById('live-cmds').textContent = b.commands ?? '—';
          document.getElementById('live-presence').textContent = b.presence || '(none)';
          const m = document.getElementById('live-maint');
          m.textContent = b.maintenance ? 'ON' : 'OFF';
          m.className = 'badge ' + (b.maintenance ? 'off' : 'on');
          const db = document.getElementById('live-db');
          if (db) {
            db.textContent = (b.db || '—').toUpperCase();
            db.className = 'badge ' + (b.db === 'mongodb' || b.db === 'connected' ? 'on' : 'off');
          }
          document.getElementById('live-logs').textContent = (d.logs || []).map(function(l) {
            return '[' + new Date(l.t).toLocaleTimeString() + '] ' + l.level + ': ' + l.message;
          }).join('\\n') || 'No logs yet';
        } catch (e) {}
      }
      tick(); setInterval(tick, 15000);
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
      <div class="banner"><div class="cap">Mind of Yuri<small>Persona · model · chamber brain</small></div></div>
      <div class="card">
        <h2>Persona core</h2>
        <p>Shapes every /prompt and DM reply. Max 12,000 characters. Saving stays on this page.</p>
        <form id="ai-form" method="POST" action="${path('/dashboard/ai')}">
          <div class="toggle-row">
            <input type="checkbox" name="enabled" value="1" ${config.enabled ? 'checked' : ''}/>
            <span style="font-size:13px">AI enabled</span>
          </div>
          <label>Custom instructions</label>
          <textarea name="systemInstructions" maxlength="12000" placeholder="Paste your full Yuri persona here…">${escapeHtml(config.systemInstructions)}</textarea>
          <label>Model</label>
          <input type="text" name="model" value="${escapeHtml(config.model)}"/>
          <div class="row">
            <button class="btn" type="submit" id="ai-save">Save</button>
            <span id="ai-status" class="meta" style="font-size:12px;color:var(--muted)"></span>
          </div>
        </form>
      </div>
      <script>
      (function(){
        var form = document.getElementById('ai-form');
        if(!form) return;
        form.addEventListener('submit', function(e){
          e.preventDefault();
          var btn = document.getElementById('ai-save');
          var st = document.getElementById('ai-status');
          btn.disabled = true; st.textContent = 'Saving…';
          var body = new URLSearchParams(new FormData(form));
          fetch(form.action, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
          }).then(function(r){ return r.json().catch(function(){ return { ok: r.ok }; }); })
            .then(function(d){
              st.textContent = d.ok !== false ? 'Saved ✓' : (d.error || 'Failed');
              st.style.color = d.ok !== false ? 'var(--val2)' : 'var(--val)';
            })
            .catch(function(){ st.textContent = 'Network error'; st.style.color = 'var(--val)'; })
            .finally(function(){ btn.disabled = false; });
        });
      })();
      </script>`,
      'ai',
    ),
  );
});

app.post(path('/dashboard/ai'), requireAuth, async (req, res) => {
  const guildId = getSessionGuildId(req);
  try {
    await saveAiConfig(discordClient, guildId, {
      enabled: req.body.enabled === '1',
      systemInstructions: String(req.body.systemInstructions || '').slice(0, 12000),
      model: String(req.body.model || 'llama-3.3-70b-instruct:free').slice(0, 120),
    });
    const wantsJson = (req.headers.accept || '').includes('application/json');
    if (wantsJson) return res.json({ ok: true, message: 'Saved' });
    res.redirect(path('/dashboard/ai') + '?saved=1');
  } catch (e) {
    if ((req.headers.accept || '').includes('application/json')) {
      return res.status(500).json({ ok: false, error: e.message });
    }
    res.redirect(path('/dashboard/ai') + '?err=1');
  }
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
      <div class="banner"><div class="cap">Sealed doors<small>Offline / maintenance mode</small></div></div>
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
    ? `<div class="flash ok">${escapeHtml(String(req.query.ok))}</div>`
    : req.query.err
      ? `<div class="flash err">${escapeHtml(String(req.query.err))}</div>`
      : '';

  const switcher = `<div class="card"><h2>Server</h2>
    <form method="POST" action="${path('/dashboard/guild')}" class="row">
      <select name="guildId" style="flex:1">${guildSelectHtml(guildId)}</select>
      <button class="btn secondary" type="submit">Switch</button>
    </form></div>`;

  let sections = '';
  for (const cat of snap.categories || []) {
    const rows = (cat.commands || [])
      .filter((c) => !c.isSubcommand)
      .map((c) => {
        const enabled = !snap.disabledCommands?.[c.name.toLowerCase()];
        const protectedCmd = c.protected || isProtectedCommand(c.name);
        const toggle = protectedCmd
          ? '<span class="meta">protected</span>'
          : `<form method="POST" action="${path('/dashboard/commands/toggle')}" class="switch-form">
              <input type="hidden" name="command" value="${escapeHtml(c.name)}"/>
              <input type="hidden" name="enable" value="${enabled ? '0' : '1'}"/>
              <label class="switch" title="${enabled ? 'Click to disable' : 'Click to enable'}">
                <input type="checkbox" ${enabled ? 'checked' : ''} onchange="this.form.submit()"/>
                <span class="slider"></span>
              </label>
            </form>`;
        return `<div class="cmd-row ${enabled ? 'on' : 'off'}">
          <div>
            <div class="name">/${escapeHtml(c.name)}</div>
            <div class="meta">${escapeHtml((c.description || '').slice(0, 80))}</div>
          </div>
          ${toggle}
        </div>`;
      })
      .join('');
    if (!rows) continue;
    sections += `<div class="card"><h2>${escapeHtml(cat.label || cat.key || 'Commands')}</h2><div class="cmd-list">${rows}</div></div>`;
  }

  res.send(
    layout(
      'Commands',
      `<h1>Commands</h1>
      <div class="banner"><div class="cap">Arsenal control<small>Toggle slash commands per server</small></div></div>
      ${flash}${switcher}${sections || '<div class="card"><p>No commands loaded.</p></div>'}`,
      'commands',
    ),
  );
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



app.get(path('/api/polls'), requireAuth, async (req, res) => {
  try {
    if (!discordClient?.db) {
      return res.json({ ok: true, tab: req.query.tab || 'active', polls: [] });
    }
    const tab = req.query.tab === 'ended' ? 'ended' : 'active';
    const verify = req.query.sync === '1' || req.query.verify === '1';
    const polls = tab === 'ended'
      ? await listEndedPolls(discordClient, { verifyDiscord: verify })
      : await listActivePolls(discordClient, { verifyDiscord: verify });
    const payload = (polls || []).map((poll) => {
      const stats = getPollStats(poll);
      return {
        id: poll.id,
        question: poll.question,
        channelId: poll.channelId,
        endsAt: poll.endsAt || null,
        endedAt: poll.endedAt || null,
        ended: !!poll.ended,
        total: stats.total,
        max: stats.max,
        winners: stats.winners,
        options: stats.options,
      };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, tab, polls: payload });
  } catch (e) {
    console.error('api/polls', e);
    res.status(200).json({ ok: false, tab: req.query.tab || 'active', polls: [], error: String(e.message || e) });
  }
});


app.post(path('/dashboard/polls/end'), requireAuth, async (req, res) => {
  const wantsJson = (req.headers.accept || '').includes('application/json');
  const pollId = String(req.body.pollId || '').trim();
  if (!pollId) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'Missing pollId' });
    return res.redirect(path('/dashboard/polls'));
  }
  try {
    const poll = await getPoll(discordClient, pollId);
    if (!poll) {
      if (wantsJson) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.redirect(path('/dashboard/polls') + '?err=1');
    }
    await endPoll(discordClient, poll);
    if (wantsJson) return res.json({ ok: true });
    return res.redirect(path('/dashboard/polls') + '?tab=ended&ok=1');
  } catch (e) {
    if (wantsJson) return res.status(500).json({ ok: false, error: e.message });
    return res.redirect(path('/dashboard/polls') + '?err=1');
  }
});

app.post(path('/dashboard/polls/edit'), requireAuth, async (req, res) => {
  const wantsJson = (req.headers.accept || '').includes('application/json');
  const pollId = String(req.body.pollId || '').trim();
  if (!pollId) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'Missing pollId' });
    return res.redirect(path('/dashboard/polls'));
  }
  try {
    const poll = await getPoll(discordClient, pollId);
    if (!poll) {
      if (wantsJson) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.redirect(path('/dashboard/polls') + '?err=1');
    }
    const result = await applyPollEdit(discordClient, poll, {
      question: req.body.question,
      optionsText: req.body.options,
      minutes: req.body.minutes,
      seconds: req.body.seconds,
    });
    if (!result.ok) {
      if (wantsJson) return res.status(400).json(result);
      return res.redirect(path('/dashboard/polls') + '?err=1');
    }
    // Re-read from DB so dashboard sees latest immediately
    const fresh = await getPoll(discordClient, pollId);
    const stats = fresh ? getPollStats(fresh) : null;
    if (wantsJson) return res.json({ ok: true, poll: fresh, stats });
    return res.redirect(path('/dashboard/polls') + '?tab=active&ok=1');
  } catch (e) {
    if (wantsJson) return res.status(500).json({ ok: false, error: e.message });
    return res.redirect(path('/dashboard/polls') + '?err=1');
  }
});

app.post(path('/dashboard/polls/delete'), requireAuth, async (req, res) => {
  const wantsJson = (req.headers.accept || '').includes('application/json');
  const pollId = String(req.body.pollId || '').trim();
  if (!pollId) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'Missing pollId' });
    return res.redirect(path('/dashboard/polls') + '?err=missing');
  }
  try {
    await deletePoll(discordClient, pollId);
    if (wantsJson) return res.json({ ok: true });
    const tab = req.body.tab === 'ended' ? 'ended' : 'active';
    return res.redirect(path('/dashboard/polls') + '?tab=' + tab + '&ok=1');
  } catch (e) {
    if (wantsJson) return res.status(500).json({ ok: false, error: e.message });
    return res.redirect(path('/dashboard/polls') + '?err=1');
  }
});

app.post(path('/dashboard/dms/delete'), requireAuth, async (req, res) => {
  const wantsJson = (req.headers.accept || '').includes('application/json');
  const userId = String(req.body.userId || '').trim();
  if (!userId) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'Missing userId' });
    return res.redirect(path('/dashboard/dms'));
  }
  try {
    const { deleteThread } = await import('./services/dmInboxService.js');
    await deleteThread(discordClient, userId);
    if (wantsJson) return res.json({ ok: true });
    return res.redirect(path('/dashboard/dms'));
  } catch (e) {
    if (wantsJson) return res.status(500).json({ ok: false, error: e.message });
    return res.redirect(path('/dashboard/dms'));
  }
});


app.get(path('/dashboard/giveaways'), requireAuth, async (req, res) => {
  let items = [];
  try {
    if (discordClient?.db?.list) {
      const keys = await discordClient.db.list('giveaway:');
      for (const k of keys.slice(0, 50)) {
        const g = await discordClient.db.get(k, null);
        if (g && typeof g === 'object') items.push({ key: k, ...g });
      }
    }
  } catch (e) {
    console.error('giveaways list', e);
  }
  items.sort((a, b) => (b.endsAt || b.endTime || 0) - (a.endsAt || a.endTime || 0));

  const cards = items.length
    ? items.map((g) => {
        const ended = g.ended || g.isEnded;
        const ends = g.endsAt || g.endTime;
        const endsLabel = ends
          ? (typeof ends === 'number' ? new Date(ends).toLocaleString() : String(ends))
          : '—';
        const parts = (g.participants || []).length;
        return `<div class="card">
          <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
            <h2 style="text-transform:none;letter-spacing:0;font-size:15px;margin:0">${escapeHtml(g.prize || g.title || g.key)}</h2>
            <span class="badge ${ended ? 'off' : 'on'}">${ended ? 'ENDED' : 'ACTIVE'}</span>
          </div>
          <p class="muted">Ends: ${escapeHtml(endsLabel)} · Entries: ${parts} · Winners: ${g.winnerCount || 1}</p>
          <div class="row" style="gap:8px;margin-top:10px">
            ${ended ? '' : `<form method="POST" action="${path('/dashboard/giveaways/end')}" style="display:inline">
              <input type="hidden" name="key" value="${escapeHtml(g.key)}"/>
              <button class="btn" type="submit">End</button></form>`}
            <form method="POST" action="${path('/dashboard/giveaways/delete')}" style="display:inline" onsubmit="return confirm('Delete giveaway from Discord + MongoDB?')">
              <input type="hidden" name="key" value="${escapeHtml(g.key)}"/>
              <button class="btn danger" type="submit">Delete</button>
            </form>
          </div>
        </div>`;
      }).join('')
    : '<div class="card"><p class="muted">No giveaways in database.</p></div>';

  res.send(
    layout(
      'Giveaways',
      `<h1>Giveaways</h1>
      <div class="banner"><div class="cap">Giveaway chamber<small>End or delete · removes MongoDB key</small></div></div>
      ${cards}`,
      'giveaways',
    ),
  );
});

app.post(path('/dashboard/giveaways/delete'), requireAuth, async (req, res) => {
  const key = String(req.body.key || '');
  if (!key.startsWith('giveaway:') || !discordClient?.db) {
    return res.redirect(path('/dashboard/giveaways'));
  }
  try {
    const g = await discordClient.db.get(key, null);
    if (g?.channelId && g?.messageId) {
      const ch = await discordClient.channels.fetch(g.channelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(g.messageId).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
    }
    await discordClient.db.delete(key);
  } catch (e) {
    console.error('gw delete', e);
  }
  res.redirect(path('/dashboard/giveaways'));
});

app.post(path('/dashboard/giveaways/end'), requireAuth, async (req, res) => {
  const key = String(req.body.key || '');
  if (!key.startsWith('giveaway:') || !discordClient?.db) {
    return res.redirect(path('/dashboard/giveaways'));
  }
  try {
    const g = await discordClient.db.get(key, null);
    if (g && !g.ended) {
      g.ended = true;
      g.isEnded = true;
      g.endedAt = new Date().toISOString();
      await discordClient.db.set(key, g);
    }
  } catch (e) {
    console.error('gw end', e);
  }
  res.redirect(path('/dashboard/giveaways'));
});

app.get(path('/dashboard/polls'), requireAuth, async (req, res) => {
  const tab = req.query.tab === 'ended' ? 'ended' : 'active';
  // Always verify Discord on full page load so deleted messages disappear
  let polls = [];
  let err = '';
  try {
    if (discordClient?.db) {
      const doVerify = req.query.sync === '1';
      polls =
        tab === 'ended'
          ? await listEndedPolls(discordClient, { verifyDiscord: doVerify })
          : await listActivePolls(discordClient, { verifyDiscord: doVerify });
    } else {
      err = 'Database offline';
    }
  } catch (e) {
    err = e.message || String(e);
  }

  function cardHtml(poll) {
    const stats = getPollStats(poll);
    const win =
      stats.max === 0
        ? '—'
        : stats.winners.length === 1
          ? escapeHtml(stats.winners[0])
          : 'Tie: ' + stats.winners.map(escapeHtml).join(', ');
    const opts = stats.options
      .map((o) => {
        const pct = stats.total ? Math.round((o.votes / stats.total) * 100) : 0;
        return `<div class="poll-opt"><div style="flex:1"><span>${escapeHtml(o.label)}</span><div class="poll-bar"><i style="width:${pct}%"></i></div></div><strong>${o.votes}</strong></div>`;
      })
      .join('');
    const leftSec = poll.endsAt
      ? Math.max(0, Math.ceil((poll.endsAt - Date.now()) / 1000))
      : 0;
    const leftMin = Math.floor(leftSec / 60);
    const leftS = leftSec % 60;
    const optsText = (poll.options || []).map((o) => o.label).join('\n');
    const actions = poll.ended
      ? `<button type="button" class="btn danger" data-del="${escapeHtml(poll.id)}" style="padding:8px 12px;font-size:12px">Delete</button>`
      : `<button type="button" class="btn secondary" data-edit-toggle="${escapeHtml(poll.id)}" style="padding:8px 12px;font-size:12px">Edit</button>
         <button type="button" class="btn" data-end="${escapeHtml(poll.id)}" style="padding:8px 12px;font-size:12px">End</button>
         <button type="button" class="btn danger" data-del="${escapeHtml(poll.id)}" style="padding:8px 12px;font-size:12px">Delete</button>`;
    const editBox = poll.ended
      ? ''
      : `<div class="poll-edit" id="edit-${escapeHtml(poll.id)}" style="display:none;margin:12px 0;padding:12px;background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:8px">
          <label class="muted" style="font-size:11px">Question</label>
          <input type="text" data-eq="${escapeHtml(poll.id)}" value="${escapeHtml(poll.question)}" maxlength="200"/>
          <label class="muted" style="font-size:11px;margin-top:8px;display:block">Options (one per line)</label>
          <textarea data-eo="${escapeHtml(poll.id)}" rows="4">${escapeHtml(optsText)}</textarea>
          <div class="row" style="margin-top:8px;gap:12px;align-items:flex-end">
            <div><label class="muted" style="font-size:11px;display:block">Minutes</label>
            <input type="number" data-em="${escapeHtml(poll.id)}" value="${leftMin}" min="0" max="10080" style="max-width:100px"/></div>
            <div><label class="muted" style="font-size:11px;display:block">Seconds</label>
            <input type="number" data-es="${escapeHtml(poll.id)}" value="${leftS}" min="0" max="59" style="max-width:100px"/></div>
          </div>
          <p class="muted" style="font-size:11px;margin:6px 0 0">Min 10 seconds total</p>
          <div class="row" style="margin-top:10px;gap:8px">
            <button type="button" class="btn" data-edit-save="${escapeHtml(poll.id)}">Save edit</button>
            <button type="button" class="btn secondary" data-edit-cancel="${escapeHtml(poll.id)}">Cancel</button>
          </div>
        </div>`;
    const timeBit = poll.ended
      ? escapeHtml(poll.endedAt ? new Date(poll.endedAt).toLocaleString() : 'ended')
      : `<span data-ends="${poll.endsAt || 0}">…</span>`;
    return `<div class="card poll-card" data-poll="${escapeHtml(poll.id)}">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <h2 style="color:var(--text);text-transform:none;letter-spacing:0;font-size:16px;margin:0">${escapeHtml(poll.question)}</h2>
        <div class="row" style="gap:6px">${actions}</div>
      </div>
      <p class="muted" style="margin:8px 0 10px">#${escapeHtml(poll.channelId)} · ${timeBit}</p>
      ${editBox}
      <div class="poll-opts">${opts}</div>
      <div class="row" style="margin-top:12px">
        <span class="badge on">Total ${stats.total}</span>
        <span class="badge ${poll.ended ? 'on' : 'off'}">${poll.ended ? 'Winner: ' : 'Leading: '}${win}</span>
      </div>
    </div>`;
  }

  const listHtml = err
    ? `<div class="card"><p class="err">${escapeHtml(err)}</p></div>`
    : polls.length
      ? polls.map(cardHtml).join('')
      : `<div class="card"><p class="muted">No ${escapeHtml(tab)} polls.</p></div>`;

  res.setHeader('Cache-Control', 'no-store');
  res.send(
    layout(
      'Polls',
      `<h1>Polls</h1>
      <div class="banner"><div class="cap">Poll chamber<small>Checks Discord on load · deleted messages drop here</small></div></div>
      <div class="row" style="margin-bottom:14px;flex-wrap:wrap">
        <a class="btn ${tab === 'active' ? '' : 'secondary'}" href="${path('/dashboard/polls')}?tab=active">Active</a>
        <a class="btn ${tab === 'ended' ? '' : 'secondary'}" href="${path('/dashboard/polls')}?tab=ended">Ended</a>
        <a class="btn secondary" href="${path('/dashboard/polls')}?tab=${tab}&sync=1">Sync now</a>
        <span class="muted" style="font-size:12px">${polls.length} shown · page verifies Discord</span>
      </div>
      <div id="poll-list">${listHtml}</div>
      <style>
        .poll-opts{display:flex;flex-direction:column;gap:6px}
        .poll-opt{display:flex;justify-content:space-between;gap:12px;padding:8px 10px;background:rgba(0,0,0,.3);border:1px solid var(--line);font-size:13px}
        .poll-opt strong{color:var(--val2)}
        .poll-card{clip-path:none!important;border-radius:10px}
        .poll-bar{height:6px;background:rgba(255,255,255,.08);border-radius:3px;margin-top:4px;overflow:hidden}
        .poll-bar > i{display:block;height:100%;background:linear-gradient(90deg,var(--val),var(--val2));border-radius:3px}
        .poll-edit input,.poll-edit textarea{width:100%;box-sizing:border-box;margin-top:4px}
      </style>
      <script>
      (function(){
        var delUrl = ${JSON.stringify(path('/dashboard/polls/delete'))};
        var endUrl = ${JSON.stringify(path('/dashboard/polls/end'))};
        var editUrl = ${JSON.stringify(path('/dashboard/polls/edit'))};
        var tab = ${JSON.stringify(tab)};
        var busy = false;

        function remain(ms){
          if(!ms) return '—';
          var left = ms - Date.now();
          if(left <= 0) return 'ending…';
          var s = Math.floor(left/1000);
          var m = Math.floor(s/60); s = s % 60;
          var h = Math.floor(m/60); m = m % 60;
          if(h>0) return h+'h '+m+'m '+s+'s';
          if(m>0) return m+'m '+s+'s';
          return s+'s';
        }
        function tickTimers(){
          document.querySelectorAll('[data-ends]').forEach(function(el){
            el.textContent = remain(Number(el.getAttribute('data-ends')));
          });
        }
        tickTimers();
        setInterval(tickTimers, 1000);

        function post(url, fields, after){
          if(busy) return;
          busy = true;
          var body = new URLSearchParams();
          Object.keys(fields).forEach(function(k){ body.set(k, fields[k]); });
          fetch(url, {
            method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
            body: body.toString()
          }).then(function(r){ return r.json().catch(function(){ return { ok:r.ok }; }); })
            .then(function(d){
              busy = false;
              if(after) after(d);
              else location.href = ${JSON.stringify(path('/dashboard/polls'))} + '?tab=' + encodeURIComponent(tab) + '&_=' + Date.now();
            })
            .catch(function(){ busy = false; location.reload(); });
        }

        document.querySelectorAll('button[data-del]').forEach(function(btn){
          btn.onclick = function(){
            if(!confirm('Delete this poll in Discord + dashboard?')) return;
            post(delUrl, { pollId: btn.getAttribute('data-del'), tab: tab });
          };
        });
        document.querySelectorAll('button[data-end]').forEach(function(btn){
          btn.onclick = function(){
            if(!confirm('End poll and reveal results?')) return;
            post(endUrl, { pollId: btn.getAttribute('data-end') }, function(){
              location.href = ${JSON.stringify(path('/dashboard/polls'))} + '?tab=ended&_=' + Date.now();
            });
          };
        });
        document.querySelectorAll('button[data-edit-toggle]').forEach(function(btn){
          btn.onclick = function(){
            var id = btn.getAttribute('data-edit-toggle');
            var el = document.getElementById('edit-'+id);
            if(!el) return;
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
          };
        });
        document.querySelectorAll('button[data-edit-cancel]').forEach(function(btn){
          btn.onclick = function(){
            var el = document.getElementById('edit-'+btn.getAttribute('data-edit-cancel'));
            if(el) el.style.display = 'none';
          };
        });
        document.querySelectorAll('button[data-edit-save]').forEach(function(btn){
          btn.onclick = function(){
            var id = btn.getAttribute('data-edit-save');
            var q = document.querySelector('input[data-eq="'+id+'"]');
            var o = document.querySelector('textarea[data-eo="'+id+'"]');
            var m = document.querySelector('input[data-em="'+id+'"]');
            var s = document.querySelector('input[data-es="'+id+'"]');
            post(editUrl, {
              pollId: id,
              question: q ? q.value : '',
              options: o ? o.value : '',
              minutes: m ? m.value : '0',
              seconds: s ? s.value : '0'
            });
          };
        });

        // No auto full-page reload (was burning Firebase quota). Use Sync now.
      })();
      </script>`,
      'polls',
    ),
  );
});


app.get(path('/dashboard/dms'), requireAuth, async (req, res) => {
  res.send(
    layout(
      'DMs',
      `<h1>Bot DMs</h1>
      <p class="muted" id="dm-flash"></p>
      <p class="muted">Live updates · scroll & typing stay put</p>
      <div id="dm-list"><p class="muted">Loading…</p></div>
      <style>
        #dm-list{width:100%;max-width:100%;overflow:hidden;display:flex;flex-direction:column;gap:14px}
        .dm-card{
          width:100%;max-width:100%;overflow:hidden;box-sizing:border-box;
          clip-path:none!important;border-radius:10px;padding:16px;
        }
        .dm-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
        .dm-head h2{margin:0;font-size:16px;text-transform:none;letter-spacing:0;color:var(--text);word-break:break-all}
        .dm-thread{
          display:flex;flex-direction:column;gap:10px;
          max-height:360px;overflow-x:hidden;overflow-y:auto;
          padding:12px;width:100%;box-sizing:border-box;
          background:rgba(0,0,0,.35);border:1px solid var(--line);
          border-radius:8px;
        }
        .bubble{
          max-width:min(78%, 460px);padding:10px 14px;border-radius:12px;
          font-size:13px;line-height:1.45;word-break:break-word;overflow-wrap:anywhere;
          box-sizing:border-box;
        }
        .bubble.user{
          align-self:flex-start;margin-right:auto;
          background:rgba(255,255,255,.07);border:1px solid var(--line);
          border-bottom-left-radius:4px;
        }
        .bubble.owner,.bubble.ai{
          align-self:flex-end;margin-left:auto;margin-right:0;
          border-bottom-right-radius:4px;
        }
        .bubble.owner{
          background:rgba(255,70,85,.28);border:1px solid rgba(255,70,85,.45);color:var(--text);
        }
        .bubble.ai{
          background:rgba(15,221,163,.14);border:1px solid rgba(15,221,163,.4);color:var(--text);
        }
        .bubble .who{font-size:10px;color:var(--muted);margin-bottom:4px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
        .dm-actions{margin-top:12px;width:100%;box-sizing:border-box}
        .dm-actions textarea{
          min-height:80px;width:100%;box-sizing:border-box;border-radius:8px;
        }
        .dm-actions textarea:focus{border-color:var(--val);box-shadow:0 0 0 2px rgba(255,70,85,.15)}
        .dm-actions .row{flex-wrap:wrap;margin-top:10px}
        .dm-actions .btn:disabled{opacity:.5;cursor:wait}
      </style>
      <script>
      const api = ${JSON.stringify(path('/api/dms'))};
      const replyUrl = ${JSON.stringify(path('/dashboard/dms/reply'))};
      const dmDelUrl = ${JSON.stringify(path('/dashboard/dms/delete'))};

      const scrollMap = {};
      const draftMap = {};
      let activeUserId = null;
      let lastFingerprint = '';
      let typingPauseUntil = 0;
      let sending = false;

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
        if(!el) return;
        el.textContent = msg || '';
        el.className = isErr ? 'err' : 'ok';
        if(msg) setTimeout(function(){ if(el.textContent===msg) el.textContent=''; }, 4000);
      }

      function isTyping(){
        const a = document.activeElement;
        return a && a.tagName === 'TEXTAREA' && a.hasAttribute('data-uid');
      }

      function saveScrollState(){
        document.querySelectorAll('.dm-thread[data-uid]').forEach(function(el){
          const uid = el.getAttribute('data-uid');
          scrollMap[uid] = el.scrollTop;
        });
        document.querySelectorAll('textarea[data-uid]').forEach(function(el){
          const uid = el.getAttribute('data-uid');
          draftMap[uid] = el.value;
          if(document.activeElement === el) activeUserId = uid;
        });
      }

      function restoreScrollState(){
        document.querySelectorAll('.dm-thread[data-uid]').forEach(function(el){
          const uid = el.getAttribute('data-uid');
          if(scrollMap[uid] != null) el.scrollTop = scrollMap[uid];
        });
        document.querySelectorAll('textarea[data-uid]').forEach(function(el){
          const uid = el.getAttribute('data-uid');
          if(draftMap[uid] != null) el.value = draftMap[uid];
          el.addEventListener('focus', function(){ activeUserId = uid; typingPauseUntil = Date.now() + 15000; });
          el.addEventListener('input', function(){
            draftMap[uid] = el.value;
            typingPauseUntil = Date.now() + 15000;
          });
          if(uid === activeUserId){
            try {
              el.focus();
              const n = el.value.length;
              el.setSelectionRange(n, n);
            } catch(e){}
          }
        });
      }

      function fingerprint(threads){
        return (threads||[]).map(function(t){
          const msgs = (t.messages||[]).map(function(m){ return m.from+':'+(m.content||'')+':'+(m.at||''); }).join('|');
          return t.userId+':'+t.status+':'+msgs;
        }).join('##');
      }

      function render(threads, force){
        const fp = fingerprint(threads);
        if(!force && fp === lastFingerprint){
          // only refresh auto-AI timers if needed
          (threads||[]).forEach(function(t){
            const card = document.querySelector('.dm-card[data-card="'+t.userId+'"]');
            if(!card) return;
            const badge = card.querySelector('.dm-head .badge');
            if(!badge) return;
            if(t.autoAiAt && t.status==='waiting_owner'){
              const left = Math.max(0, Math.floor((t.autoAiAt - Date.now())/1000));
              badge.className = 'badge off';
              badge.textContent = 'Auto-AI '+Math.floor(left/60)+'m '+(left%60)+'s';
            }
          });
          return;
        }
        lastFingerprint = fp;
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
            '<div class="dm-head"><h2>'+esc(t.userTag)+'</h2><div class="row">'+timer+
            '<button type="button" class="btn danger" data-dm-del="'+esc(t.userId)+'" style="padding:6px 10px;font-size:11px">Delete</button></div></div>'+
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
        sending = true;
        typingPauseUntil = Date.now() + 20000;
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
            scrollMap[userId] = 999999;
            lastFingerprint = '';
            await tick(true);
          }
        } catch(e){
          flash('Network error', true);
        } finally {
          sending = false;
          buttons.forEach(function(b){ b.disabled = false; });
        }
      }

      function bindSendButtons(){
        document.querySelectorAll('button[data-send]').forEach(function(btn){
          btn.onclick = function(){
            sendReply(btn.getAttribute('data-uid'), btn.getAttribute('data-send'));
          };
        });
        document.querySelectorAll('button[data-dm-del]').forEach(function(btn){
          btn.onclick = function(){
            if(!confirm('Remove this DM thread from dashboard?')) return;
            var body = new URLSearchParams();
            body.set('userId', btn.getAttribute('data-dm-del'));
            fetch(dmDelUrl, {
              method:'POST', credentials:'same-origin',
              headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
              body: body.toString()
            }).then(function(){ lastFingerprint=''; tick(true); }).catch(function(){});
          };
        });
      }

      async function tick(force){
        if(!force && (sending || Date.now() < typingPauseUntil || isTyping())) return;
        try{
          const r = await fetch(api, { credentials:'same-origin' });
          if(!r.ok) return;
          const d = await r.json();
          render(d.threads||[], !!force);
        }catch(e){}
      }
      tick(true);
      setInterval(function(){ tick(false); }, 3000);
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
