import express from 'express';
import { getWelcomeConfig, saveWelcomeConfig } from './utils/database.js';
import { DEFAULT_BANORANT_WELCOME, DEFAULT_BANORANT_GOODBYE } from './utils/welcomeTemplates.js';
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
app.set('trust proxy', 1);
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
function createSession(extra = {}) {
  const token = signToken();
  sessions.set(token, {
    expiresAt: Date.now() + SESSION_TTL_MS,
    guildId: extra.guildId || DEFAULT_GUILD_ID || null,
    role: extra.role || 'owner', // 'owner' | 'guild_admin'
    userId: extra.userId || null,
    allowedGuilds: extra.allowedGuilds || null, // null = all (owner)
  });
  return token;
}
function getSession(req) {
  const token = getCookie(req, 'yuri_dash');
  if (!token || !isValidSession(token)) return null;
  return sessions.get(token);
}
function isOwnerSession(req) {
  const s = getSession(req);
  return s?.role === 'owner';
}
function requireOwner(req, res, next) {
  if (!isValidSession(getCookie(req, 'yuri_dash'))) {
    return res.redirect(303, path('/login'));
  }
  if (!isOwnerSession(req)) {
    return res.status(403).send(layout('Forbidden', '<p class="err">Owner only.</p>', ''));
  }
  next();
}
function ownerIdsList() {
  return String(process.env.OWNER_IDS || process.env.OWNER_ID || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
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
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const val = encodeURIComponent(token);
  // Two paths so both / and /panel work behind proxies (HTTP + HTTPS)
  res.setHeader('Set-Cookie', [
    `yuri_dash=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    `yuri_dash=${val}; Path=/panel; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  ]);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [
    'yuri_dash=; Path=/; HttpOnly; Max-Age=0',
    'yuri_dash=; Path=/panel; HttpOnly; Max-Age=0',
  ]);
}
function requireAuth(req, res, next) {
  if (!isValidSession(getCookie(req, 'yuri_dash'))) {
    return res.redirect(303, path('/login'));
  }
  const s = getSession(req);
  req.dashRole = s?.role || 'owner';
  req.dashUserId = s?.userId || null;
  req.dashAllowedGuilds = s?.allowedGuilds || null;
  next();
}
function layoutFor(req, title, body, active = '') {
  return layout(title, body, active, { role: req?.dashRole || 'owner' });
}

function denyGuildAdmin(req, res) {
  if (req.dashRole === 'guild_admin') {
    res.status(403).send(layoutFor(req, 'Forbidden', '<div class="card"><p class="err">This section is for the bot owner only. You can manage commands & welcome for your server.</p></div>', 'dashboard'));
    return true;
  }
  return false;
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

function layout(title, body, active = '', opts = {}) {
  const role = opts.role || 'owner';
  const allNav = [
    ['dashboard', 'Overview', '◆', path('/dashboard')],
    ['ai', 'AI', '✦', path('/dashboard/ai')],
    ['commands', 'Commands', '▣', path('/dashboard/commands')],
    ['dms', 'DMs', '✉', path('/dashboard/dms')],
    ['polls', 'Polls', '📊', path('/dashboard/polls')],
    ['giveaways', 'Giveaways', '🎁', path('/dashboard/giveaways')],
    ['welcome', 'Welcome', '👋', path('/dashboard/welcome')],
    ['messages', 'Messages', '✎', path('/dashboard/messages')],
    ['maintenance', 'Maintenance', '⚙', path('/dashboard/maintenance')],
  ];
  const guildAdminAllowed = new Set(['dashboard', 'commands', 'welcome', 'polls', 'giveaways']);
  const navItems = role === 'guild_admin'
    ? allNav.filter((x) => guildAdminAllowed.has(x[0]))
    : allNav;
  const nav = navItems
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
.shell{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:22px 16px 40px;overflow-x:hidden;width:100%;box-sizing:border-box;padding-top:72px;}
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

.top{position:sticky;top:0;z-index:50;
  position:fixed;top:0;left:0;right:0;z-index:1000;
  display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;
  padding:10px 16px;
  background:rgba(8,10,14,.94);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-bottom:1px solid rgba(255,70,85,.22);
  box-shadow:0 8px 24px rgba(0,0,0,.35);
}
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
  min-height:100dvh;min-height:100vh;
  display:flex;align-items:center;justify-content:center;
  padding:24px 16px;box-sizing:border-box;
  overflow:auto;
}
body.is-login .shell{padding-top:0 !important;min-height:100dvh}
body.is-login .top,body.is-login .hero{display:none !important}
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

@media (max-width:720px){
  .shell{padding:12px 12px;padding-top:140px !important}
  .top{
    flex-direction:column;align-items:stretch;gap:8px;
    padding:8px 10px;
    position:fixed;top:0;left:0;right:0;z-index:100;
  }
  .nav{
    display:grid !important;
    grid-template-columns:repeat(4,minmax(0,1fr));
    gap:6px;
    overflow:visible !important;
    flex-wrap:unset !important;
    width:100%;
  }
  .nav-link{
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    text-align:center;padding:8px 4px;font-size:10px;letter-spacing:.04em;
    white-space:normal;line-height:1.2;min-height:44px;
  }
  .nav-ico{font-size:14px;margin-bottom:2px}
  .top form{width:100%}
  .top .btn{width:100%}
  .login-screen{min-height:100dvh;align-items:center;justify-content:center;padding:20px}
  .login-card{width:100%;max-width:380px;margin:auto}
  .grid-2{grid-template-columns:1fr !important}
  .stat-grid{grid-template-columns:1fr 1fr}
  .hero{margin-top:0}
  h1{font-size:22px}
}


.top-brand{display:flex;align-items:center;gap:10px;flex:0 0 auto}
.top-brand .brand span{font-size:9px}
.shell-main{padding-top:8px;max-width:1100px;margin:0 auto}
.shell{padding-top:78px !important}
@media (max-width:720px){
  .shell{padding-top:168px !important}
  .shell-main{padding-top:12px}
  .top-brand .brand{font-size:14px}
  .top{flex-direction:column;align-items:stretch}
  .top-brand{justify-content:center;padding-top:4px}
  h1{margin-top:8px}
  .banner{margin-top:8px}
  .card:first-of-type{margin-top:8px}
}


/* —— Welcome page + stronger Valorant mobile —— */
.val-bar{height:3px;background:linear-gradient(90deg,#ff4655,transparent 60%);margin:0 0 14px}
.badge{display:inline-block;padding:3px 8px;border-radius:2px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.badge-on{background:rgba(70,200,120,.15);color:#5ddea0;border:1px solid rgba(70,200,120,.35)}
.badge-off{background:rgba(255,70,85,.12);color:#ff8a94;border:1px solid rgba(255,70,85,.3)}
.badge-miss{background:rgba(250,166,26,.12);color:#ffc857;border:1px solid rgba(250,166,26,.3)}
.guild-select{width:100%;max-width:420px;background:#12161e;border:1px solid rgba(255,70,85,.35);color:#fff;padding:10px 12px;border-radius:4px;font-family:inherit}
.welcome-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:720px){
  .welcome-grid{grid-template-columns:1fr}
  .nav{grid-template-columns:repeat(4,minmax(0,1fr)) !important}
  textarea{min-height:160px;font-size:16px} /* prevent iOS zoom */
  input,select,.guild-select{font-size:16px}
  .top{position:fixed !important;top:0;left:0;right:0;z-index:200;background:rgba(11,14,19,.96);backdrop-filter:blur(10px)}
  .shell{padding-top:168px !important}
}
.preview-box{background:rgba(0,0,0,.35);border-left:3px solid #ff4655;padding:12px 14px;white-space:pre-wrap;font-size:13px;line-height:1.45;max-height:220px;overflow:auto;border-radius:0 4px 4px 0}


/* Welcome page V2 */
.vselect{
  appearance:none;-webkit-appearance:none;
  width:100%;max-width:100%;
  background:#0e1218 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23ff4655' d='M1 1l5 5 5-5'/%3E%3C/svg%3E") right 12px center/12px no-repeat;
  border:1px solid rgba(255,70,85,.45);
  color:#f2f4f8;padding:11px 36px 11px 12px;border-radius:2px;
  font-family:var(--display),Rajdhani,sans-serif;font-weight:600;letter-spacing:.04em;
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}
.vselect:focus{outline:none;border-color:#ff4655;box-shadow:0 0 0 1px rgba(255,70,85,.35)}
.vselect:disabled{opacity:.45;cursor:not-allowed}
.vbtn-row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}
.vtoggle{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  min-width:120px;padding:10px 16px;cursor:pointer;border:none;
  font-family:var(--display),Rajdhani,sans-serif;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:12px;
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
}
.vtoggle.on{background:#ff4655;color:#fff;box-shadow:0 0 16px rgba(255,70,85,.35)}
.vtoggle.off{background:rgba(255,255,255,.06);color:#9aa3b2;border:1px solid rgba(255,255,255,.12)}
.vtoggle:disabled{opacity:.4;cursor:not-allowed}
.btn-danger{
  background:transparent;color:#ff8a94;border:1px solid rgba(255,70,85,.5);
  padding:10px 14px;font-family:var(--display),Rajdhani,sans-serif;font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:12px;cursor:pointer;
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
}
.btn-danger:hover{background:rgba(255,70,85,.15);color:#fff}
.btn-danger:disabled{opacity:.4;cursor:not-allowed}
.section-title{font-family:var(--display),Rajdhani,sans-serif;font-size:22px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:0 0 14px;padding-top:4px}
.welcome-page .card h2{border:none}
@media (max-width:720px){
  .shell{padding-top:168px !important}
  .section-title{padding-top:8px;font-size:20px}
  .welcome-page h1,.welcome-page .section-title{scroll-margin-top:160px}
  .vtoggle{flex:1;min-width:140px}
}


/* —— Global Valorant form controls —— */
select, .vselect{
  appearance:none;-webkit-appearance:none;
  width:100%;max-width:100%;
  background:#0e1218 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23ff4655' d='M1 1l5 5 5-5'/%3E%3C/svg%3E") right 12px center/12px no-repeat;
  border:1px solid rgba(255,70,85,.45);
  color:#f2f4f8;padding:11px 36px 11px 12px;border-radius:2px;
  font-family:var(--display),Rajdhani,sans-serif;font-weight:600;letter-spacing:.04em;
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}
select:focus,.vselect:focus{outline:none;border-color:#ff4655;box-shadow:0 0 0 1px rgba(255,70,85,.35)}
select:disabled{opacity:.45}
textarea, input[type=text], input[type=password], input[type=number]{
  background:#0e1218;border:1px solid rgba(255,70,85,.35);color:#f2f4f8;
  padding:11px 12px;border-radius:2px;
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
  font-family:inherit;
}
textarea:focus,input[type=text]:focus,input[type=password]:focus,input[type=number]:focus{
  outline:none;border-color:#ff4655;box-shadow:0 0 0 1px rgba(255,70,85,.3);
}
/* Valorant switch for native checkboxes */
input[type=checkbox].vswitch,
input[type=checkbox]:not(.plain){
  appearance:none;-webkit-appearance:none;
  width:46px;height:24px;border-radius:2px;position:relative;cursor:pointer;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);
  vertical-align:middle;flex-shrink:0;
  clip-path:polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px));
}
input[type=checkbox].vswitch:checked,
input[type=checkbox]:not(.plain):checked{
  background:#ff4655;border-color:#ff4655;box-shadow:0 0 12px rgba(255,70,85,.4);
}
input[type=checkbox].vswitch::after,
input[type=checkbox]:not(.plain)::after{
  content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;background:#c5c9d1;
  clip-path:polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));
  transition:left .15s ease;
}
input[type=checkbox].vswitch:checked::after,
input[type=checkbox]:not(.plain):checked::after{
  left:24px;background:#fff;
}
.role-pill{display:inline-block;padding:2px 8px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;
  border:1px solid rgba(255,70,85,.4);color:#ff8a94;margin-left:8px}


/* —— UI polish Aug 2026 —— */
:root{
  --val2:#ff6b78; /* was green — unify to red family */
  --gray:#6b7280;
  --gray2:#9aa3b2;
}
body{
  background:
    radial-gradient(ellipse 90% 50% at 50% -10%, rgba(255,70,85,.14), transparent 55%),
    radial-gradient(ellipse 50% 40% at 100% 100%, rgba(255,70,85,.06), transparent 45%),
    linear-gradient(180deg, #07090d 0%, #0b0e13 40%, #0a0c10 100%) !important;
}
body::before{
  content:'';position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.35;
  background-image:
    linear-gradient(rgba(255,70,85,.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,70,85,.04) 1px, transparent 1px);
  background-size:48px 48px;
  mask-image:radial-gradient(ellipse at center, #000 20%, transparent 75%);
}
/* Command rows: red = on, gray = off */
.cmd-row.on{border-left:3px solid #ff4655 !important}
.cmd-row.off{border-left:3px solid #4b5563 !important;opacity:.7}
.switch .slider{background:#4b5563 !important}
.switch input:checked + .slider{background:#ff4655 !important;box-shadow:0 0 12px rgba(255,70,85,.45)}
.switch input:not(:checked) + .slider{background:#4b5563 !important}
.badge.on{background:rgba(255,70,85,.15)!important;color:#ff8a94!important;border-color:rgba(255,70,85,.4)!important}
.badge.off{background:rgba(75,85,99,.25)!important;color:#9aa3b2!important;border:1px solid rgba(75,85,99,.5)!important}
h2{color:#ff6b78 !important}

/* Force all selects */
select{
  appearance:none!important;-webkit-appearance:none!important;
  background:#0e1218 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23ff4655' d='M1 1l5 5 5-5'/%3E%3C/svg%3E") right 12px center/12px no-repeat !important;
  border:1px solid rgba(255,70,85,.45)!important;
  color:#f2f4f8!important;padding:11px 36px 11px 12px!important;
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
  border-radius:2px!important;
  font-family:var(--display),Rajdhani,sans-serif!important;font-weight:600!important;
}
select:focus{border-color:#ff4655!important;box-shadow:0 0 0 1px rgba(255,70,85,.35)!important}

/* Hamburger mobile nav */
.nav-toggle{
  display:none;width:44px;height:44px;align-items:center;justify-content:center;
  background:rgba(255,70,85,.12);border:1px solid rgba(255,70,85,.4);color:#fff;cursor:pointer;
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
}
.nav-toggle span{display:block;width:20px;height:2px;background:#fff;margin:3px 0;transition:.2s}
.nav-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:150}
body.nav-open .nav-backdrop{display:block}
.intel-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.intel-tile{
  background:rgba(0,0,0,.35);border:1px solid rgba(255,70,85,.2);padding:12px 14px;
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}
.intel-tile .k{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-family:var(--display)}
.intel-tile .v{font-size:18px;font-weight:700;color:#fff;font-family:var(--display);margin-top:4px}
.intel-tile .v.accent{color:#ff4655}
@media (max-width:720px){
  .nav-toggle{display:inline-flex}
  .top{
    flex-direction:row!important;align-items:center!important;justify-content:space-between!important;
    flex-wrap:nowrap!important;padding:8px 10px!important;
  }
  .top .nav{
    display:none!important;position:fixed;top:56px;left:10px;right:10px;z-index:160;
    flex-direction:column!important;grid-template-columns:none!important;
    background:rgba(10,12,16,.98)!important;border:1px solid rgba(255,70,85,.35);
    padding:10px!important;max-height:70vh;overflow:auto;
    clip-path:polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px));
  }
  body.nav-open .top .nav{display:flex!important}
  body.nav-open .top .nav .nav-link{
    display:flex!important;flex-direction:row!important;justify-content:flex-start!important;
    width:100%;padding:12px 14px!important;font-size:13px!important;min-height:auto;
  }
  .top form{width:auto!important}
  .top .btn{width:auto!important}
  .shell{padding-top:72px!important}
  .intel-grid{grid-template-columns:1fr 1fr}
  .top-brand{flex:1}
  .top-actions{display:flex;align-items:center;gap:8px}
}


/* —— Centered top bar + polished mobile menu —— */
.top{
  display:grid !important;
  grid-template-columns:1fr auto 1fr !important;
  align-items:center !important;
  justify-content:center !important;
  gap:12px !important;
  flex-wrap:nowrap !important;
  padding:10px 20px !important;
  max-width:100%;
}
.top-brand, .brand-wrap{justify-self:start;display:flex;align-items:center;gap:10px}
.top .nav, #mainNav{
  justify-self:center !important;
  display:flex !important;
  flex-wrap:wrap;
  justify-content:center;
  max-width:min(900px,70vw);
}
.top-actions{
  justify-self:end !important;
  display:flex;align-items:center;gap:8px;
}
/* Soft background */
body{
  background:
    radial-gradient(ellipse 100% 60% at 50% -20%, rgba(255,70,85,.11), transparent 60%),
    radial-gradient(ellipse 60% 40% at 0% 80%, rgba(255,70,85,.05), transparent 50%),
    #0a0c10 !important;
}
body::before{
  opacity:.18 !important;
  background-image:
    linear-gradient(rgba(255,70,85,.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,70,85,.03) 1px, transparent 1px) !important;
  background-size:64px 64px !important;
  mask-image:radial-gradient(ellipse at 50% 30%, #000 0%, transparent 70%) !important;
}
/* Hamburger icon */
.nav-toggle{
  width:44px;height:44px;padding:0;border:1px solid rgba(255,70,85,.45);
  background:rgba(255,70,85,.1);display:none;align-items:center;justify-content:center;cursor:pointer;
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
}
.nav-toggle .bars{display:flex;flex-direction:column;gap:5px;width:18px}
.nav-toggle .bars i{display:block;height:2px;width:100%;background:#fff;border-radius:1px;transition:transform .2s,opacity .2s}
body.nav-open .nav-toggle .bars i:nth-child(1){transform:translateY(7px) rotate(45deg)}
body.nav-open .nav-toggle .bars i:nth-child(2){opacity:0}
body.nav-open .nav-toggle .bars i:nth-child(3){transform:translateY(-7px) rotate(-45deg)}
.nav-backdrop{background:rgba(0,0,0,.6)!important;backdrop-filter:blur(2px)}
@media (max-width:720px){
  .top{
    grid-template-columns:1fr auto auto !important;
    padding:8px 12px !important;
  }
  .top-actions{gap:6px}
  .nav-toggle{display:inline-flex !important}
  .top .nav, #mainNav{
    display:none !important;
    position:fixed !important;
    top:58px !important;
    left:50% !important;
    right:auto !important;
    transform:translateX(-50%) !important;
    width:min(360px, calc(100vw - 24px)) !important;
    max-width:360px !important;
    z-index:160 !important;
    flex-direction:column !important;
    justify-content:flex-start !important;
    background:rgba(12,14,18,.98) !important;
    border:1px solid rgba(255,70,85,.4) !important;
    padding:8px !important;
    max-height:min(70vh, 480px) !important;
    overflow:auto !important;
    box-shadow:0 16px 40px rgba(0,0,0,.55);
  }
  body.nav-open .top .nav, body.nav-open #mainNav{display:flex !important}
  body.nav-open .top .nav .nav-link, body.nav-open #mainNav .nav-link{
    width:100% !important;
    justify-content:flex-start !important;
    padding:12px 14px !important;
    font-size:13px !important;
  }
  .shell{padding-top:70px !important}
}
@media (min-width:721px){
  .nav-toggle{display:none !important}
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
        <div class="top">
          <div class="top-brand">
            <div class="avatar" style="width:36px;height:36px;font-size:14px">◆</div>
            <div class="brand" style="font-size:16px">Yuri's Chamber<span>BANORANT CAFE</span></div>
          </div>
          <div class="top-actions">
          <button type="button" class="nav-toggle" id="navToggle" aria-label="Menu">
            <div class="bars"><i></i><i></i><i></i></div>
          </button>
        </div>
        <nav class="nav" id="mainNav">${nav}</nav>
        <div class="nav-backdrop" id="navBackdrop"></div>
          <form method="POST" action="${path('/logout')}" style="margin:0"><button class="btn secondary" type="submit">Log out</button></form>
        </div>
        <div class="shell-main">
        ${body}
        <div class="credits">
          <strong>Credits</strong><br/>
          Bot &amp; dashboard: <a href="${process.env.OFFICIAL_WEBSITE || 'https://github.com/YuriRinkashime'}" target="_blank" rel="noopener"><strong>Yuri Rinkashime (RinkaYuri)</strong></a> · BANORANT CAFE 🎮<br/>
          Runtime: Yuri's Chamber · Built for Filipino Valorant community<br/>
          Design inspired by VALORANT agent Chamber · Not affiliated with Riot Games
        </div>
        <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
          <form method="POST" action="${path('/dashboard/restart')}" onsubmit="return confirm('Restart the bot process now?')">
            <button class="btn secondary" type="submit">Restart bot</button>
          </form>
        </div>
        <p class="footer-note">Owner access only · sealed chamber</p>
        </div>
      </div>`
}
<script>
(function(){
  var t=document.getElementById('navToggle');
  var b=document.getElementById('navBackdrop');
  function close(){document.body.classList.remove('nav-open')}
  function toggle(){document.body.classList.toggle('nav-open')}
  if(t) t.addEventListener('click', function(e){e.preventDefault();toggle()});
  if(b) b.addEventListener('click', close);
  document.querySelectorAll('#mainNav .nav-link').forEach(function(a){
    a.addEventListener('click', close);
  });
})();
</script>
</body>
</html>`;
}

app.post(path('/dashboard/stop'), requireOwner, (req, res) => {
  res.send(layout('Stopped', '<div class="card"><p class="err">Bot process stopping. Use your host panel to Start again if it does not auto-restart.</p></div>', 'dashboard'));
  setTimeout(() => { try { process.exit(1); } catch (_) {} }, 500);
});

app.post(path('/dashboard/restart'), requireOwner, (req, res) => {
  res.send(layout(
    'Restart',
    `<div class="card">
      <p class="ok"><strong>Restart signal sent</strong> (crash-exit so Bot-Hosting can auto-start).</p>
      <p class="muted">If status stays <strong>Stopped</strong>, open Bot-Hosting and press <strong>Start</strong>.</p>
      <p id="rs" class="muted">Checking…</p>
      <script>
        setInterval(async function(){
          try {
            var r = await fetch(${JSON.stringify(path('/health'))}, { cache: 'no-store' });
            if (r.ok) location.href = ${JSON.stringify(path('/dashboard'))};
          } catch (e) {}
        }, 5000);
        setTimeout(function(){ location.replace(location.pathname + '?_=' + Date.now()); }, 90000);
      </script>
    </div>`,
    'dashboard',
  ));
  setTimeout(function(){ try { process.exit(1); } catch (e) {} }, 900);
});

app.get('/health', (req, res) => res.json({ status: 'healthy' }));
app.get('/ready', (req, res) => {
  res.json({
    ready: true,
    bot: Boolean(discordClient?.user),
    uptime: formatUptime(),
    maintenance: isMaintenanceModeRuntime(),
  });
});
app.get('/', (req, res) => res.redirect(303, path('/login')));
if (BASE) app.get(BASE, (req, res) => res.redirect(303, path('/login')));

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
        userName: t.userName || (t.userTag ? String(t.userTag).split('#')[0] : null),
        status: t.status || 'open',
        messages: t.messages || [],
        autoAiAt: t.autoAiAt || null,
      })),
    });
  } catch (e) {
    console.error('api/dms', e);
    res.status(500).json({ ok: false, error: e.message, threads: [] });
  }
});

app.get(path('/login'), (req, res) => {
  if (isValidSession(getCookie(req, 'yuri_dash'))) return res.redirect(303, path('/dashboard'));
  let err = '';
  if (req.query.error === '1') err = '<p class="err">Wrong username or password.</p>';
  if (req.query.error === 'config') err = '<p class="err">Login is not configured.</p>';
  res.send(
    layout(
      'Login',
      `${err}
      <form method="POST" action="${path('/login')}" autocomplete="off">
        <input type="text" name="fakeuser" value="" style="position:absolute;left:-9999px" tabindex="-1" autocomplete="off"/>
        <input type="password" name="fakepass" value="" style="position:absolute;left:-9999px" tabindex="-1" autocomplete="off"/>
        <label>Username</label>
        <input type="text" name="username" required autocomplete="off" readonly onfocus="this.removeAttribute('readonly')" autocapitalize="off" spellcheck="false"/>
        <label>Password</label>
        <input type="password" name="password" required autocomplete="new-password" readonly onfocus="this.removeAttribute('readonly')"/>
        <div class="row"><button class="btn" type="submit">Log in</button></div>
      </form>`,
      'login',
    ),
  );
});

app.post(path('/login'), async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  // Bot owner (env)
  if (DASHBOARD_USERNAME && DASHBOARD_PASSWORD) {
    const userOk = username === DASHBOARD_USERNAME;
    const a = Buffer.from(password);
    const b = Buffer.from(DASHBOARD_PASSWORD);
    const passOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (userOk && passOk) {
      const token = createSession({ role: 'owner', guildId: DEFAULT_GUILD_ID || null, allowedGuilds: null });
      setSessionCookie(res, token);
      return res.redirect(303, path('/dashboard'));
    }
  }

  // Guild manager accounts (Mongo)
  try {
    const key = `dashboard:user:${username.toLowerCase()}`;
    const acc = discordClient?.db ? await discordClient.db.get(key, null) : null;
    if (acc?.passwordHash) {
      const hash = crypto.createHash('sha256').update(password + ':' + username.toLowerCase()).digest('hex');
      if (hash === acc.passwordHash && acc.role === 'guild_admin') {
        const gids = Array.isArray(acc.guildIds) ? acc.guildIds : [];
        const token = createSession({
          role: 'guild_admin',
          guildId: gids[0] || null,
          allowedGuilds: gids,
          userId: username.toLowerCase(),
        });
        setSessionCookie(res, token);
        return res.redirect(303, path('/dashboard'));
      }
    }
  } catch (_) {}

  return res.redirect(303, path('/login') + '?error=1');
});

app.post(path('/logout'), requireAuth, (req, res) => {
  const t = getCookie(req, 'yuri_dash');
  if (t) sessions.delete(t);
  clearSessionCookie(res);
  res.redirect(303, path('/login'));
});

app.post(path('/dashboard/guild'), requireAuth, (req, res) => {
  const token = getCookie(req, 'yuri_dash');
  const s = sessions.get(token);
  const gid = String(req.body.guildId || '');
  if (s && discordClient?.guilds?.cache?.has(gid)) {
    if (s.role === 'guild_admin' && Array.isArray(s.allowedGuilds) && !s.allowedGuilds.includes(gid)) {
      return res.redirect(path('/dashboard'));
    }
    s.guildId = gid;
  }
  const back = String(req.body.back || '') || path('/dashboard/commands');
  res.redirect(back.startsWith('/') ? back : path('/dashboard/commands'));
});


app.post(path('/dashboard/presence'), requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 128);
    const typeName = String(req.body?.type || 'Custom');
    if (!text) return res.redirect(path('/dashboard') + '?err=presence');

    const { ActivityType } = await import('discord.js');
    const TYPE_MAP = {
      Playing: ActivityType.Playing,
      Watching: ActivityType.Watching,
      Listening: ActivityType.Listening,
      Competing: ActivityType.Competing,
      Custom: ActivityType.Custom,
    };
    const type = TYPE_MAP[typeName] ?? ActivityType.Custom;
    const presence =
      type === ActivityType.Custom
        ? { activities: [{ name: 'Custom Status', type, state: text }], status: 'online' }
        : { activities: [{ name: text, type }], status: 'online' };

    if (discordClient?.user) {
      await discordClient.user.setPresence(presence);
    }
    if (discordClient?.db) {
      await discordClient.db.set('bot:presence', {
        text,
        typeName,
        updatedAt: Date.now(),
      });
    }
    presenceCache.data = { text, typeName };
    presenceCache.at = Date.now();
    return res.redirect(path('/dashboard') + '?presence=1');
  } catch (e) {
    console.error('presence save failed:', e);
    return res.redirect(path('/dashboard') + '?err=presence');
  }
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
          <div class="intel-grid">
            <div class="intel-tile"><div class="k">Database</div><div class="v accent">MongoDB</div></div>
            <div class="intel-tile"><div class="k">Level profiles</div><div class="v">${levelUsers}</div></div>
            <div class="intel-tile"><div class="k">Active polls</div><div class="v" id="intel-polls">${activePolls}</div></div>
            <div class="intel-tile"><div class="k">Guilds online</div><div class="v" id="intel-guilds">—</div></div>
          </div>
          <ul class="intel" style="margin-top:12px">
            <li><span class="dot"></span> Presence: edit below or <code>/status</code></li>
            <li><span class="dot"></span> Polls &amp; Giveaways tabs manage live events</li>
            <li><span class="dot"></span> Levels persist in Mongo across restarts</li>
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
        <div class="card" id="process-controls" style="margin-top:16px;border-color:rgba(255,70,85,.3)">
          <h2>Process controls</h2>
          <p class="muted">Host must auto-restart after stop/restart. Start = wake process if host supports it.</p>
          <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">
            <form method="POST" action="${path('/dashboard/restart')}" onsubmit="return confirm('Restart bot now?')">
              <button class="btn" type="submit">Restart</button>
            </form>
            <form method="POST" action="${path('/dashboard/stop')}" onsubmit="return confirm('Stop bot process? Panel will go offline until host restarts it.')">
              <button class="btn danger" type="submit">Stop</button>
            </form>
            <a class="btn secondary" href="${path('/dashboard')}">Refresh / Start check</a>
          </div>
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
      tick(); setInterval(tick, 3000);
      </script>`,
      'dashboard',
    ),
  );
});


app.get(path('/dashboard/ai'), requireAuth, async (req, res) => {
  if (denyGuildAdmin(req, res)) return;
  const guildId = getSessionGuildId(req) || DEFAULT_GUILD_ID;
  const { getAiConfig, listAiModels } = await import('./services/aiService.js');
  const config = await getAiConfig(discordClient, guildId);
  const models = listAiModels();
  const options = models
    .map(
      (m) =>
        `<option value="${escapeHtml(m.id)}" ${
          config.modelId === m.id ? 'selected' : ''
        }>${escapeHtml(m.label)}${m.vision ? ' · Vision' : ' · Text'}${m.free ? ' · Free' : ''}</option>`,
    )
    .join('');
  const saved = req.query.saved ? '<p class="ok">Saved.</p>' : '';
  const err = req.query.err ? '<p class="err">Save failed.</p>' : '';
  res.send(
    layout(
      'AI',
      `<h1>AI</h1>
      <div class="banner"><div class="cap">Mind of Yuri<small>Persona · default model · chamber brain</small></div></div>
      ${saved}${err}
      <div class="card">
        <form id="ai-form" method="POST" action="${path('/dashboard/ai')}">
          <label class="row" style="gap:10px;align-items:center">
            <input type="checkbox" name="enabled" value="1" ${config.enabled ? 'checked' : ''}/>
            <span>AI enabled</span>
          </label>
          <label style="margin-top:12px">Default model (server)</label>
          <select name="modelId" style="width:100%;padding:10px;border-radius:8px;background:rgba(0,0,0,.35);color:var(--text);border:1px solid var(--line)">
            ${options}
          </select>
          <p class="muted">Everyone uses this unless they run <code>/aimodel</code>. Chat history is shared across models.</p>
          <label style="margin-top:12px">System instructions</label>
          <textarea name="systemInstructions" rows="16">${escapeHtml(config.systemInstructions || '')}</textarea>
          <label style="margin-top:12px">Max reply length</label>
          <input type="number" name="maxReplyLength" value="${escapeHtml(String(config.maxReplyLength || 1800))}" min="200" max="4000"/>
          <button class="btn" type="submit" style="margin-top:14px">Save</button>
        </form>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Models in this bot</h2>
        <ul class="muted" style="line-height:1.7;margin:8px 0 0 18px">
          <li><strong>CosmosRP V2.1</strong> — vision + roleplay (Pawan). Best for pics/gifs + RP tone.</li>
          <li><strong>Gemma 4 26B Free</strong> — OpenRouter multimodal. Needs <code>OPENROUTER_API_KEY</code>.</li>
          <li><strong>Llama 3.3 70B</strong> — Naga free, text only. Needs <code>NAGA_API_KEY</code>.</li>
        </ul>
        <p class="muted" style="margin-top:12px"><strong>Discord:</strong> <code>/aimodel</code> switches per user (sticky). History stays the same.</p>
        <p class="muted"><strong>@bot / reply</strong> and <code>/prompt</code> use the active model. Vision models get photo/GIF context.</p>
      </div>`,
      'ai',
    ),
  );
});

app.post(path('/dashboard/ai'), requireAuth, async (req, res, next) => { if (denyGuildAdmin(req, res)) return; return next(); }, async (req, res) => {
  try {
    const guildId = getSessionGuildId(req) || DEFAULT_GUILD_ID;
    const { saveAiConfig, findAiModel } = await import('./services/aiService.js');
    const modelId = String(req.body.modelId || '').slice(0, 80);
    const catalog = findAiModel(modelId);
    await saveAiConfig(discordClient, guildId, {
      enabled: req.body.enabled === '1' || req.body.enabled === 'on',
      modelId: catalog?.id || modelId || undefined,
      model: catalog?.model || modelId,
      systemInstructions: String(req.body.systemInstructions || '').slice(0, 12000),
      maxReplyLength: Math.min(4000, Math.max(200, parseInt(req.body.maxReplyLength, 10) || 1800)),
    });
    res.redirect(path('/dashboard/ai') + '?saved=1');
  } catch (e) {
    console.error('ai save', e);
    res.redirect(path('/dashboard/ai') + '?err=1');
  }
});

app.get(path('/dashboard/maintenance'), requireAuth, async (req, res) => {
  if (denyGuildAdmin(req, res)) return;
  const guildId = getSessionGuildId(req);
  if (guildId && discordClient) await loadRuntimeSettings(discordClient, guildId);
  const on = isMaintenanceModeRuntime();
  const msg = getMaintenanceMessage();
  const saved = req.query.saved ? '<p class="ok">Saved.</p>' : '';
  res.send(
    layout(
      'Maintenance',
      `<h1>MAINTENANCE</h1>
      <div class="banner" style="background:linear-gradient(135deg,rgba(255,70,85,.25),rgba(15,20,28,.9));border-color:rgba(255,70,85,.45)">
        <div class="cap">SEALED DOORS<small>VALORANT PROTOCOL · OFFLINE / MAINTENANCE</small></div>
      </div>
      ${saved}
      <div class="card" style="border-color:rgba(255,70,85,.35);box-shadow:0 0 30px rgba(255,70,85,.12)">
        <form method="POST" action="${path('/dashboard/maintenance')}">
          <input type="hidden" name="maintenanceMode" id="maintVal" value="${on ? '1' : '0'}"/>
          <label style="margin-bottom:8px">MAINTENANCE MODE</label>
          <div class="vbtn-row" style="margin-bottom:14px">
            <button type="button" class="vtoggle ${on ? 'on' : 'off'}" id="maintBtn">${on ? 'ENABLED' : 'DISABLED'}</button>
          </div>
          <label style="color:var(--muted);font-size:11px;letter-spacing:.12em">MESSAGE TO USERS</label>
          <textarea name="maintenanceMessage" rows="5" style="border-color:rgba(255,70,85,.3)">${escapeHtml(msg || '')}</textarea>
          <p class="muted" style="margin-top:8px">When ON, commands reply with this message. Active polls/giveaways pause entry.</p>
          <button class="btn" type="submit" style="margin-top:12px">SAVE PROTOCOL</button>
        </form>
        <script>
        (function(){
          var btn=document.getElementById('maintBtn');
          var inp=document.getElementById('maintVal');
          if(!btn||!inp) return;
          btn.addEventListener('click', function(){
            var on = inp.value !== '1';
            inp.value = on ? '1' : '0';
            btn.classList.toggle('on', on);
            btn.classList.toggle('off', !on);
            btn.textContent = on ? 'ENABLED' : 'DISABLED';
          });
        })();
        </script>
      </div>`,
      'maintenance',
    ),
  );
});

app.post(path('/dashboard/maintenance'), requireOwner, async (req, res) => {
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
      ? await listEndedPolls(discordClient, { verifyDiscord: true }, { verifyDiscord: verify })
      : await listActivePolls(discordClient, { verifyDiscord: true }, { verifyDiscord: verify });
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
    poll.paused = true;
    try { await discordClient.db.set && null; } catch(_) {}
    try {
      const { savePoll, syncPollMessage } = await import('./services/pollService.js');
      await savePoll(discordClient, poll);
      await syncPollMessage(discordClient, poll).catch(() => {});
    } catch (_) {}
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
  // Server-side load so page never sticks on "Loading…"
  let items = [];
  try {
    if (discordClient?.db?.list) {
      const keys = (await discordClient.db.list('giveaway:').catch(() => [])) || [];
      for (const k of keys.slice(0, 80)) {
        if (typeof k !== 'string' || (k.match(/:/g) || []).length !== 1) continue;
        const g = await discordClient.db.get(k, null);
        if (!g || typeof g !== 'object') continue;
        if (!(g.prize || g.messageId || g.endsAt)) continue;
        items.push({
          key: k,
          prize: g.prize,
          ended: !!(g.ended || g.isEnded),
          endsAt: g.endsAt || g.endTime || null,
          entrants: g.entrants || g.participants || [],
          winners: g.winners || g.winnerCount || 1,
          winnerIds: g.winnerIds || [],
        });
      }
    }
  } catch (e) {
    console.error('giveaways page', e);
  }
  items.sort((a, b) => (b.endsAt || 0) - (a.endsAt || 0));

  const cards = items.length
    ? items.map((g) => {
        const ends = g.endsAt ? new Date(g.endsAt).toLocaleString() : '—';
        const entries = (g.entrants || []).length;
        const winners = (g.winnerIds || []).map((id) => escapeHtml('@' + id)).join(', ') || (g.ended ? '<em>none</em>' : '—');
        return `<div class="card">
          <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
            <h2 style="text-transform:none;letter-spacing:0;font-size:15px;margin:0">${escapeHtml(g.prize || g.key)}</h2>
            <span class="badge ${g.ended ? 'off' : 'on'}">${g.ended ? 'ENDED' : 'ACTIVE'}</span>
          </div>
          <p class="muted">Ends: ${escapeHtml(ends)} · Entries: ${entries} · Winner slots: ${g.winners || 1}</p>
          ${g.ended ? `<p class="muted">Winners: ${winners}</p>` : ''}
          <div class="row" style="gap:8px;margin-top:10px">
            ${g.ended ? '' : `<form method="POST" action="${path('/dashboard/giveaways/end')}" style="display:inline">
              <input type="hidden" name="key" value="${escapeHtml(g.key)}"/>
              <button class="btn" type="submit">End</button></form>`}
            <form method="POST" action="${path('/dashboard/giveaways/delete')}" style="display:inline" onsubmit="return confirm('Delete giveaway + winner message?')">
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
      <div class="banner"><div class="cap">Giveaway chamber<small>Server-rendered · auto-refresh every 8s</small></div></div>
      <div id="gw-root">${cards}</div>
      <script>
      setTimeout(function(){ location.reload(); }, 8000);
      </script>`,
      'giveaways',
    ),
  );
});

app.get(path('/api/giveaways'), requireAuth, async (req, res) => {
  const items = [];
  try {
    if (!discordClient?.db) {
      return res.json({ items: [], at: Date.now(), error: 'db offline' });
    }
    const keys = (await discordClient.db.list('giveaway:').catch(() => [])) || [];
    for (const k of keys.slice(0, 80)) {
      if (typeof k !== 'string') continue;
      // real giveaways: giveaway:ID (exactly one colon)
      if ((k.match(/:/g) || []).length !== 1) continue;
      const g = await discordClient.db.get(k, null);
      if (!g || typeof g !== 'object') continue;
      if (!(g.prize || g.messageId || g.endsAt)) continue;
      items.push({
        key: k,
        prize: g.prize,
        ended: !!(g.ended || g.isEnded),
        isEnded: !!(g.ended || g.isEnded),
        endsAt: g.endsAt || g.endTime || null,
        entrants: g.entrants || g.participants || [],
        participants: g.participants || g.entrants || [],
        winners: g.winners || g.winnerCount || 1,
        winnerCount: g.winnerCount || g.winners || 1,
        winnerIds: g.winnerIds || [],
        messageId: g.messageId,
        channelId: g.channelId,
      });
    }
  } catch (e) {
    console.error('api giveaways', e);
    return res.status(500).json({ items: [], error: e.message, at: Date.now() });
  }
  items.sort((a, b) => (b.endsAt || 0) - (a.endsAt || 0));
  res.json({ items, at: Date.now() });
});

app.post(path('/dashboard/giveaways/delete'), requireAuth, async (req, res) => {
  const key = String(req.body.key || '');
  if (!key.startsWith('giveaway:') || !discordClient?.db) {
    return res.redirect(path('/dashboard/giveaways'));
  }
  try {
    const g = await discordClient.db.get(key, null);
    if (g?.channelId) {
      const ch = await discordClient.channels.fetch(g.channelId).catch(() => null);
      if (ch) {
        if (g.messageId) {
          const msg = await ch.messages.fetch(g.messageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
        // winner announcement message
        if (g.winnerMessageId) {
          const wmsg = await ch.messages.fetch(g.winnerMessageId).catch(() => null);
          if (wmsg) await wmsg.delete().catch(() => {});
        }
      }
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
    const { endSimpleGiveaway } = await import('./commands/Fun/giveaway.js');
    const id = key.replace(/^giveaway:/, '');
    await endSimpleGiveaway(discordClient, id);
  } catch (e) {
    console.error('gw end', e);
    // fallback flag only
    try {
      const g = await discordClient.db.get(key, null);
      if (g) {
        g.ended = true;
        g.isEnded = true;
        g.endedAt = new Date().toISOString();
        await discordClient.db.set(key, g);
      }
    } catch (_) {}
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
          ? await listEndedPolls(discordClient, { verifyDiscord: true }, { verifyDiscord: doVerify })
          : await listActivePolls(discordClient, { verifyDiscord: true }, { verifyDiscord: doVerify });
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
      
/* —— Welcome page + stronger Valorant mobile —— */
.val-bar{height:3px;background:linear-gradient(90deg,#ff4655,transparent 60%);margin:0 0 14px}
.badge{display:inline-block;padding:3px 8px;border-radius:2px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.badge-on{background:rgba(70,200,120,.15);color:#5ddea0;border:1px solid rgba(70,200,120,.35)}
.badge-off{background:rgba(255,70,85,.12);color:#ff8a94;border:1px solid rgba(255,70,85,.3)}
.badge-miss{background:rgba(250,166,26,.12);color:#ffc857;border:1px solid rgba(250,166,26,.3)}
.guild-select{width:100%;max-width:420px;background:#12161e;border:1px solid rgba(255,70,85,.35);color:#fff;padding:10px 12px;border-radius:4px;font-family:inherit}
.welcome-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:720px){
  .welcome-grid{grid-template-columns:1fr}
  .nav{grid-template-columns:repeat(4,minmax(0,1fr)) !important}
  textarea{min-height:160px;font-size:16px} /* prevent iOS zoom */
  input,select,.guild-select{font-size:16px}
  .top{position:fixed !important;top:0;left:0;right:0;z-index:200;background:rgba(11,14,19,.96);backdrop-filter:blur(10px)}
  .shell{padding-top:168px !important}
}
.preview-box{background:rgba(0,0,0,.35);border-left:3px solid #ff4655;padding:12px 14px;white-space:pre-wrap;font-size:13px;line-height:1.45;max-height:220px;overflow:auto;border-radius:0 4px 4px 0}

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
  if (denyGuildAdmin(req, res)) return;
  let threads = [];
  let listErr = '';
  try {
    const { listInbox } = await import('./services/dmInboxService.js');
    threads = (await listInbox(discordClient)) || [];
  } catch (e) {
    console.error('dms page list', e);
    listErr = e.message || String(e);
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function mediaHtml(m) {
    let html = '';
    for (const med of m.media || []) {
      const u = med.url || '';
      if (!u) continue;
      const ct = (med.contentType || '').toLowerCase();
      const low = u.toLowerCase();
      const isGif = ct.includes('gif') || /\.gif(\?|$)/i.test(low) || /tenor\.|giphy\.|klipy\./i.test(low);
      const isImg = ct.startsWith('image') || isGif || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(low);
      if (isImg) {
        html += `<div style="margin-top:6px"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="" style="max-width:100%;max-height:280px;border-radius:8px;border:1px solid var(--line)" loading="lazy"/></a></div>`;
      } else if (ct.startsWith('video') || /\.(mp4|webm|mov)(\?|$)/i.test(low)) {
        html += `<div style="margin-top:6px"><video src="${esc(u)}" controls style="max-width:100%;max-height:260px;border-radius:8px"></video></div>`;
      } else {
        html += `<div style="margin-top:6px"><a href="${esc(u)}" target="_blank">${esc(med.name || 'file')}</a></div>`;
      }
    }
    return html;
  }

  function renderCards(list) {
    if (listErr) return `<div class="card"><p class="err">Failed to load DMs: ${esc(listErr)}</p></div>`;
    if (!list.length) return `<div class="card"><p class="muted">No DMs yet.</p></div>`;
    return list.map((t) => {
      const displayName = t.userName
        ? `@${t.userName}`
        : t.userTag
          ? `@${String(t.userTag).split('#')[0]}`
          : 'user';
      const bubbles = (t.messages || [])
        .map((m) => {
          const who = m.from === 'user' ? displayName : m.from === 'ai' ? 'AI' : 'You';
          const cls = m.from === 'user' ? 'user' : m.from === 'ai' ? 'ai' : 'owner';
          return `<div class="bubble ${cls}"><div class="who">${esc(who)}</div>${m.content ? esc(m.content) : ''}${mediaHtml(m)}</div>`;
        })
        .join('');
      let badge = `<span class="badge on">${esc(t.status || 'open')}</span>`;
      if (t.autoAiAt && t.status === 'waiting_owner') {
        const left = Math.max(0, Math.floor((t.autoAiAt - Date.now()) / 1000));
        badge = `<span class="badge off">Auto-AI ${Math.floor(left / 60)}m ${left % 60}s</span>`;
      }
      return `<div class="card dm-card" data-card="${esc(t.userId)}">
        <div class="dm-head"><h2>${esc(displayName)}</h2><div class="row">${badge}
          <form method="POST" action="${path('/dashboard/dms/delete')}" style="display:inline" onsubmit="return confirm('Remove from dashboard only?')">
            <input type="hidden" name="userId" value="${esc(t.userId)}"/><button class="btn danger" type="submit" style="padding:6px 10px;font-size:11px">Delete</button>
          </form></div></div>
        <div class="dm-thread" data-uid="${esc(t.userId)}">${bubbles}</div>
        <div class="dm-actions">
          <form method="POST" action="${path('/dashboard/dms/reply')}">
            <input type="hidden" name="userId" value="${esc(t.userId)}"/>
            <input type="hidden" name="mode" value="human"/>
            <textarea name="content" data-uid="${esc(t.userId)}" placeholder="Type your reply…" required></textarea>
            <div class="row" style="margin-top:10px;gap:8px">
              <button class="btn" type="submit">Send my words</button>
            </div>
          </form>
          <form method="POST" action="${path('/dashboard/dms/reply')}" style="margin-top:8px">
            <input type="hidden" name="userId" value="${esc(t.userId)}"/>
            <input type="hidden" name="mode" value="ai"/>
            <input type="hidden" name="content" value=""/>
            <button class="btn secondary" type="submit">AI reply</button>
          </form>
        </div>
      </div>`;
    }).join('');
  }

  const initialJson = JSON.stringify(
    threads.map((t) => ({
      userId: t.userId,
      userTag: t.userTag,
      userName: t.userName,
      status: t.status,
      messages: t.messages || [],
      autoAiAt: t.autoAiAt,
    })),
  ).replace(/</g, '\\u003c');

  res.send(
    layout(
      'DMs',
      `<h1>Bot DMs</h1>
      <p class="muted">Scroll stays put · only snaps to latest if you were already at the bottom</p>
      <div id="dm-list">${renderCards(threads)}</div>
      <style>
        #dm-list{display:flex;flex-direction:column;gap:14px}
        .dm-card{border-radius:10px;padding:16px}
        .dm-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
        .dm-head h2{margin:0;font-size:16px;text-transform:none;letter-spacing:0}
        .dm-thread{display:flex;flex-direction:column;gap:10px;max-height:70vh;overflow-y:auto;padding:12px;background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:8px}
        .bubble{max-width:min(78%,460px);padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.45;word-break:break-word}
        .bubble.user{align-self:flex-start;background:rgba(255,255,255,.07);border:1px solid var(--line)}
        .bubble.owner{align-self:flex-end;background:rgba(255,70,85,.28);border:1px solid rgba(255,70,85,.45)}
        .bubble.ai{align-self:flex-end;background:rgba(15,221,163,.14);border:1px solid rgba(15,221,163,.4)}
        .bubble .who{font-size:10px;color:var(--muted);margin-bottom:4px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
        .dm-actions textarea{min-height:80px;width:100%;box-sizing:border-box;border-radius:8px}
      
/* —— Welcome page + stronger Valorant mobile —— */
.val-bar{height:3px;background:linear-gradient(90deg,#ff4655,transparent 60%);margin:0 0 14px}
.badge{display:inline-block;padding:3px 8px;border-radius:2px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.badge-on{background:rgba(70,200,120,.15);color:#5ddea0;border:1px solid rgba(70,200,120,.35)}
.badge-off{background:rgba(255,70,85,.12);color:#ff8a94;border:1px solid rgba(255,70,85,.3)}
.badge-miss{background:rgba(250,166,26,.12);color:#ffc857;border:1px solid rgba(250,166,26,.3)}
.guild-select{width:100%;max-width:420px;background:#12161e;border:1px solid rgba(255,70,85,.35);color:#fff;padding:10px 12px;border-radius:4px;font-family:inherit}
.welcome-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:720px){
  .welcome-grid{grid-template-columns:1fr}
  .nav{grid-template-columns:repeat(4,minmax(0,1fr)) !important}
  textarea{min-height:160px;font-size:16px} /* prevent iOS zoom */
  input,select,.guild-select{font-size:16px}
  .top{position:fixed !important;top:0;left:0;right:0;z-index:200;background:rgba(11,14,19,.96);backdrop-filter:blur(10px)}
  .shell{padding-top:168px !important}
}
.preview-box{background:rgba(0,0,0,.35);border-left:3px solid #ff4655;padding:12px 14px;white-space:pre-wrap;font-size:13px;line-height:1.45;max-height:220px;overflow:auto;border-radius:0 4px 4px 0}

</style>
      <script>
      (function(){
        const api = ${JSON.stringify(path('/api/dms'))};
        const scrollMap = {};
        const nearBottom = {};
        const draftMap = {};
        let lastFp = '';
        let pauseUntil = 0;

        function esc(s){
          return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }
        function mediaHtml(m){
          let html = '';
          (m.media||[]).forEach(function(med){
            const u = med.url||'';
            if(!u) return;
            const ct=(med.contentType||'').toLowerCase();
            const low=u.toLowerCase();
            const isGif=ct.indexOf('gif')>=0||/\\.gif(\\?|$)/i.test(low)||/tenor\\.|giphy\\.|klipy\\./i.test(low);
            const isImg=ct.indexOf('image')===0||isGif||/\\.(png|jpe?g|webp|gif)(\\?|$)/i.test(low);
            if(isImg) html += '<div style="margin-top:6px"><a href="'+esc(u)+'" target="_blank"><img src="'+esc(u)+'" style="max-width:100%;max-height:280px;border-radius:8px" loading="lazy"/></a></div>';
            else if(ct.indexOf('video')===0||/\\.(mp4|webm|mov)(\\?|$)/i.test(low)) html += '<div style="margin-top:6px"><video src="'+esc(u)+'" controls style="max-width:100%;max-height:260px"></video></div>';
            else html += '<div style="margin-top:6px"><a href="'+esc(u)+'" target="_blank">'+esc(med.name||'file')+'</a></div>';
          });
          return html;
        }
        function saveState(){
          document.querySelectorAll('.dm-thread[data-uid]').forEach(function(el){
            const uid = el.getAttribute('data-uid');
            scrollMap[uid] = el.scrollTop;
            nearBottom[uid] = (el.scrollHeight - el.scrollTop - el.clientHeight) < 80;
          });
          document.querySelectorAll('textarea[data-uid]').forEach(function(el){
            draftMap[el.getAttribute('data-uid')] = el.value;
          });
        }
        function isTyping(){
          const a = document.activeElement;
          return a && a.tagName==='TEXTAREA' && a.hasAttribute('data-uid');
        }
        function render(threads){
          const box = document.getElementById('dm-list');
          if(!threads.length){
            box.innerHTML = '<div class="card"><p class="muted">No DMs yet.</p></div>';
            return;
          }
          box.innerHTML = threads.map(function(t){
            const displayName = t.userName ? ('@'+t.userName) : (t.userTag ? ('@'+String(t.userTag).split('#')[0]) : 'user');
            const hist = (t.messages||[]).map(function(m){
              const who = m.from==='user' ? displayName : (m.from==='ai'?'AI':'You');
              const cls = m.from==='user'?'user':(m.from==='ai'?'ai':'owner');
              return '<div class="bubble '+cls+'"><div class="who">'+esc(who)+'</div>'+(m.content?esc(m.content):'')+mediaHtml(m)+'</div>';
            }).join('');
            let badge = '<span class="badge on">'+esc(t.status||'open')+'</span>';
            if(t.autoAiAt && t.status==='waiting_owner'){
              const left = Math.max(0, Math.floor((t.autoAiAt - Date.now())/1000));
              badge = '<span class="badge off">Auto-AI '+Math.floor(left/60)+'m '+(left%60)+'s</span>';
            }
            return '<div class="card dm-card" data-card="'+esc(t.userId)+'">'+
              '<div class="dm-head"><h2>'+esc(displayName)+'</h2><div class="row">'+badge+
              '<form method="POST" action="${path('/dashboard/dms/delete')}" style="display:inline" onsubmit="return confirm(\\'Remove?\\')"><input type="hidden" name="userId" value="'+esc(t.userId)+'"/><button class="btn danger" type="submit" style="padding:6px 10px;font-size:11px">Delete</button></form></div></div>'+
              '<div class="dm-thread" data-uid="'+esc(t.userId)+'">'+hist+'</div>'+
              '<div class="dm-actions"><form method="POST" action="${path('/dashboard/dms/reply')}"><input type="hidden" name="userId" value="'+esc(t.userId)+'"/><input type="hidden" name="mode" value="human"/>'+
              '<textarea name="content" data-uid="'+esc(t.userId)+'" placeholder="Type your reply…" required></textarea>'+
              '<div class="row" style="margin-top:10px"><button class="btn" type="submit">Send my words</button></div></form>'+
              '<form method="POST" action="${path('/dashboard/dms/reply')}" style="margin-top:8px"><input type="hidden" name="userId" value="'+esc(t.userId)+'"/><input type="hidden" name="mode" value="ai"/><input type="hidden" name="content" value=""/>'+
              '<button class="btn secondary" type="submit">AI reply</button></form></div></div>';
          }).join('');
          document.querySelectorAll('.dm-thread[data-uid]').forEach(function(el){
            const uid = el.getAttribute('data-uid');
            if(nearBottom[uid]) el.scrollTop = el.scrollHeight;
            else if(scrollMap[uid] != null) el.scrollTop = scrollMap[uid];
            // first visit: start at bottom once
            else el.scrollTop = el.scrollHeight;
          });
          document.querySelectorAll('textarea[data-uid]').forEach(function(el){
            const uid = el.getAttribute('data-uid');
            if(draftMap[uid] != null) el.value = draftMap[uid];
            el.addEventListener('input', function(){ draftMap[uid]=el.value; pauseUntil=Date.now()+20000; });
            el.addEventListener('focus', function(){ pauseUntil=Date.now()+20000; });
          });
        }
        async function softRefresh(){
          if(isTyping() && Date.now() < pauseUntil) return;
          saveState();
          try{
            const r = await fetch(api, { credentials:'same-origin', cache:'no-store' });
            if(!r.ok) return;
            const d = await r.json();
            const threads = d.threads || [];
            const fp = JSON.stringify(threads.map(function(t){ return [t.userId,(t.messages||[]).length,t.status,t.autoAiAt]; }));
            if(fp === lastFp) return;
            lastFp = fp;
            render(threads);
          }catch(e){}
        }
        // first paint already SSR — mark near-bottom true for initial threads
        document.querySelectorAll('.dm-thread[data-uid]').forEach(function(el){
          el.scrollTop = el.scrollHeight;
          nearBottom[el.getAttribute('data-uid')] = true;
          el.addEventListener('scroll', function(){
            const uid = el.getAttribute('data-uid');
            scrollMap[uid] = el.scrollTop;
            nearBottom[uid] = (el.scrollHeight - el.scrollTop - el.clientHeight) < 80;
          });
        });
        document.querySelectorAll('textarea[data-uid]').forEach(function(el){
          el.addEventListener('input', function(){ draftMap[el.getAttribute('data-uid')]=el.value; pauseUntil=Date.now()+20000; });
        });
        setInterval(softRefresh, 5000);
      })();
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
      const { generateDmReply } = await import('./services/aiService.js');
      const thread = await getThread(discordClient, userId);
      const lastUser = [...(thread.messages || [])]
        .reverse()
        .find((m) => m.from === 'user');
      const userMessage = lastUser?.content || content || 'Hello';
      text = await generateDmReply(discordClient, userId, userMessage);
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




// ——— Welcome / Goodbye V2 ———
function listTextChannels(guild) {
  try {
    return [...guild.channels.cache.values()]
      .filter((c) => c.isTextBased?.() && !c.isThread?.())
      .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
      .map((c) => ({ id: c.id, name: c.name }));
  } catch (_) {
    return [];
  }
}

function channelSelectHtml(channels, selected, { allowEmpty = true, disabled = false } = {}) {
  const empty = allowEmpty ? '<option value="">— none —</option>' : '';
  const opts =
    channels
      .map(
        (c) =>
          `<option value="${escapeHtml(c.id)}"${c.id === selected ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`,
      )
      .join('') || '<option value="">No text channels</option>';
  return `<select class="vselect" name="channelId" ${disabled ? 'disabled' : ''}>${empty}${opts}</select>`;
}

app.get(path('/dashboard/welcome'), requireAuth, async (req, res) => {
  try {
    const token = getCookie(req, 'yuri_dash');
    const sess = sessions.get(token) || {};
    const guilds = [];
    try {
      for (const g of discordClient?.guilds?.cache?.values?.() || []) {
        guilds.push({ id: g.id, name: g.name });
      }
    } catch (_) {}
    guilds.sort((a, b) => a.name.localeCompare(b.name));

    const guildId =
      String(req.query.guildId || sess.guildId || process.env.GUILD_ID || '').trim() ||
      (guilds[0] && guilds[0].id) ||
      null;
    if (guildId && sess) sess.guildId = guildId;

    let cfg = {};
    try {
      if (guildId) cfg = (await getWelcomeConfig(discordClient, guildId)) || {};
    } catch (_) {
      cfg = {};
    }

    const guild = guildId ? discordClient?.guilds?.cache?.get(guildId) : null;
    const channels = guild ? listTextChannels(guild) : [];

    const saved = req.query.saved === '1' ? '<p class="ok">Saved to MongoDB.</p>' : '';
    const deleted = req.query.deleted
      ? `<p class="ok">Deleted ${escapeHtml(String(req.query.deleted))} setup.</p>`
      : '';
    const err = req.query.err ? `<p class="err">${escapeHtml(String(req.query.err))}</p>` : '';

    const welcomeReady = Boolean(cfg.enabled && cfg.channelId && (cfg.welcomeMessage || '').trim());
    const goodbyeReady = Boolean(
      cfg.goodbyeEnabled && cfg.goodbyeChannelId && (cfg.leaveMessage || '').trim(),
    );
    const hasWelcomeSetup = Boolean(cfg.channelId || cfg.enabled || (cfg.welcomeMessage || '').trim());
    const hasGoodbyeSetup = Boolean(
      cfg.goodbyeChannelId || cfg.goodbyeEnabled || (cfg.leaveMessage || '').trim(),
    );

    let statusHtml = '';
    if (!guildId) statusHtml = '<p class="err">No server selected.</p>';
    else if (!hasWelcomeSetup && !hasGoodbyeSetup) {
      statusHtml =
        '<p class="muted">No Welcome/Goodbye configured yet. Use the Add buttons.</p>';
    } else {
      const bits = [];
      bits.push(
        welcomeReady
          ? '<span class="badge badge-on">Welcome ready</span>'
          : hasWelcomeSetup
            ? '<span class="badge badge-miss">Welcome incomplete</span>'
            : '<span class="badge badge-off">No welcome</span>',
      );
      bits.push(
        goodbyeReady
          ? '<span class="badge badge-on">Goodbye ready</span>'
          : hasGoodbyeSetup
            ? '<span class="badge badge-miss">Goodbye incomplete</span>'
            : '<span class="badge badge-off">No goodbye</span>',
      );
      statusHtml = `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0">${bits.join('')}</div>`;
    }

    const guildOptions = guilds
      .map(
        (g) =>
          `<option value="${escapeHtml(g.id)}"${g.id === guildId ? ' selected' : ''}>${escapeHtml(g.name)}</option>`,
      )
      .join('');

    const welcomeMsg = cfg.welcomeMessage || DEFAULT_BANORANT_WELCOME;
    const goodbyeMsg = cfg.leaveMessage || DEFAULT_BANORANT_GOODBYE;
    const wStyle = (cfg.welcomeStyle || 'text').toLowerCase() === 'embed' ? 'embed' : 'text';
    const gStyle = (cfg.goodbyeStyle || 'embed').toLowerCase() === 'text' ? 'text' : 'embed';

    const chOpts = (selected) =>
      channels
        .map(
          (c) =>
            `<option value="${escapeHtml(c.id)}"${c.id === selected ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`,
        )
        .join('') || '<option value="">No text channels</option>';

    res.send(
      layout(
        'Welcome / Goodbye',
        `<div class="welcome-page">
        <h1 class="section-title">Welcome &amp; Goodbye</h1>
        ${saved}${deleted}${err}
        <div class="banner"><div class="cap">Per-server messages<small>Text or card · Mongo guild:{id}:welcome</small></div></div>

        <div class="card">
          <h2>Select server</h2>
          <form method="get" action="${path('/dashboard/welcome')}">
            <select class="vselect" name="guildId" onchange="this.form.submit()">${guildOptions || '<option value="">No servers</option>'}</select>
          </form>
          ${statusHtml}
        </div>

        <div class="welcome-grid" style="margin-top:14px">
          <div class="card">
            <h2>Add Welcome</h2>
            <p class="muted">Quick-create with BANORANT default text.</p>
            <form method="post" action="${path('/dashboard/welcome/add')}">
              <input type="hidden" name="guildId" value="${escapeHtml(guildId || '')}"/>
              <input type="hidden" name="kind" value="welcome"/>
              <label>Channel</label>
              <select class="vselect" name="channelId" ${hasWelcomeSetup ? 'disabled' : ''} style="margin-bottom:10px">${chOpts(cfg.channelId || '')}</select>
              <label>Style</label>
              <select class="vselect" name="style" ${hasWelcomeSetup ? 'disabled' : ''} style="margin-bottom:12px">
                <option value="text">Text message</option>
                <option value="embed">Card (embed)</option>
              </select>
              <button class="btn${hasWelcomeSetup ? ' secondary' : ''}" type="submit" ${hasWelcomeSetup ? 'disabled' : ''}>Add Welcome</button>
            </form>
          </div>
          <div class="card">
            <h2>Add Goodbye</h2>
            <p class="muted">Quick-create with BANORANT default text.</p>
            <form method="post" action="${path('/dashboard/welcome/add')}">
              <input type="hidden" name="guildId" value="${escapeHtml(guildId || '')}"/>
              <input type="hidden" name="kind" value="goodbye"/>
              <label>Channel</label>
              <select class="vselect" name="channelId" ${hasGoodbyeSetup ? 'disabled' : ''} style="margin-bottom:10px">${chOpts(cfg.goodbyeChannelId || '')}</select>
              <label>Style</label>
              <select class="vselect" name="style" ${hasGoodbyeSetup ? 'disabled' : ''} style="margin-bottom:12px">
                <option value="embed" selected>Card (embed)</option>
                <option value="text">Text message</option>
              </select>
              <button class="btn${hasGoodbyeSetup ? ' secondary' : ''}" type="submit" ${hasGoodbyeSetup ? 'disabled' : ''}>Add Goodbye</button>
            </form>
          </div>
        </div>

        <form method="post" action="${path('/dashboard/welcome')}" class="card" style="margin-top:14px">
          <input type="hidden" name="guildId" value="${escapeHtml(guildId || '')}"/>
          <div class="welcome-grid">
            <div>
              <h2>Welcome settings</h2>
              <input type="hidden" name="enabled" id="enabledVal" value="${cfg.enabled ? '1' : '0'}"/>
              <div class="vbtn-row">
                <button type="button" class="vtoggle ${cfg.enabled ? 'on' : 'off'}" data-toggle="enabledVal" data-on="Enable" data-off="Disabled">
                  ${cfg.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <label>Channel</label>
              <select class="vselect" name="channelId" style="margin-bottom:10px">
                <option value="">— none —</option>${chOpts(cfg.channelId || '')}
              </select>
              <label>Display style</label>
              <input type="hidden" name="welcomeStyle" id="wStyleVal" value="${wStyle}"/>
              <div class="vbtn-row">
                <button type="button" class="vtoggle ${wStyle === 'text' ? 'on' : 'off'}" data-style="wStyleVal" data-value="text">Text</button>
                <button type="button" class="vtoggle ${wStyle === 'embed' ? 'on' : 'off'}" data-style="wStyleVal" data-value="embed">Card</button>
              </div>
              <label>Message</label>
              <textarea name="welcomeMessage" rows="12" style="width:100%">${escapeHtml(welcomeMsg)}</textarea>
              <div style="margin-top:12px">
                <button formaction="${path('/dashboard/welcome/delete')}" formmethod="post" name="kind" value="welcome" class="btn-danger" ${hasWelcomeSetup ? '' : 'disabled'} onclick="return confirm('Delete welcome setup for this server?')">Delete Welcome</button>
              </div>
            </div>
            <div>
              <h2>Goodbye settings</h2>
              <input type="hidden" name="goodbyeEnabled" id="goodbyeVal" value="${cfg.goodbyeEnabled ? '1' : '0'}"/>
              <div class="vbtn-row">
                <button type="button" class="vtoggle ${cfg.goodbyeEnabled ? 'on' : 'off'}" data-toggle="goodbyeVal" data-on="Enable" data-off="Disabled">
                  ${cfg.goodbyeEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <label>Channel</label>
              <select class="vselect" name="goodbyeChannelId" style="margin-bottom:10px">
                <option value="">— none —</option>${chOpts(cfg.goodbyeChannelId || '')}
              </select>
              <label>Display style</label>
              <input type="hidden" name="goodbyeStyle" id="gStyleVal" value="${gStyle}"/>
              <div class="vbtn-row">
                <button type="button" class="vtoggle ${gStyle === 'text' ? 'on' : 'off'}" data-style="gStyleVal" data-value="text">Text</button>
                <button type="button" class="vtoggle ${gStyle === 'embed' ? 'on' : 'off'}" data-style="gStyleVal" data-value="embed">Card</button>
              </div>
              <label>Message</label>
              <textarea name="leaveMessage" rows="12" style="width:100%">${escapeHtml(goodbyeMsg)}</textarea>
              <div style="margin-top:12px">
                <button formaction="${path('/dashboard/welcome/delete')}" formmethod="post" name="kind" value="goodbye" class="btn-danger" ${hasGoodbyeSetup ? '' : 'disabled'} onclick="return confirm('Delete goodbye setup for this server?')">Delete Goodbye</button>
              </div>
            </div>
          </div>
          <p class="muted" style="margin-top:10px">Tokens: <code>{user}</code> <code>{user.tag}</code> <code>{username}</code> <code>{server}</code> <code>{membercount}</code></p>
          <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn" type="submit">Save to MongoDB</button>
            <button class="btn secondary" type="submit" name="loadDefaults" value="1">Load BANORANT defaults</button>
          </div>
        </form>
        </div>
        <script>
        (function(){
          document.querySelectorAll('[data-toggle]').forEach(function(btn){
            btn.addEventListener('click', function(){
              var id = btn.getAttribute('data-toggle');
              var inp = document.getElementById(id);
              if(!inp) return;
              var on = inp.value !== '1';
              inp.value = on ? '1' : '0';
              btn.classList.toggle('on', on);
              btn.classList.toggle('off', !on);
              btn.textContent = on ? 'Enabled' : 'Disabled';
            });
          });
          document.querySelectorAll('[data-style]').forEach(function(btn){
            btn.addEventListener('click', function(){
              var id = btn.getAttribute('data-style');
              var val = btn.getAttribute('data-value');
              var inp = document.getElementById(id);
              if(!inp) return;
              inp.value = val;
              btn.parentElement.querySelectorAll('[data-style]').forEach(function(b){
                var active = b.getAttribute('data-value') === val;
                b.classList.toggle('on', active);
                b.classList.toggle('off', !active);
              });
            });
          });
        })();
        </script>`,
        'welcome',
      ),
    );
  } catch (e) {
    res.status(500).send('Welcome page error: ' + (e.message || e));
  }
});

app.post(path('/dashboard/welcome/add'), requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const token = getCookie(req, 'yuri_dash');
    const sess = sessions.get(token) || {};
    const guildId = String(req.body.guildId || sess.guildId || process.env.GUILD_ID || '').trim();
    const kind = String(req.body.kind || '');
    const channelId = String(req.body.channelId || '').trim();
    const style = String(req.body.style || 'text').toLowerCase() === 'embed' ? 'embed' : 'text';
    if (!guildId) return res.redirect(path('/dashboard/welcome') + '?err=' + encodeURIComponent('No server'));
    if (!channelId)
      return res.redirect(
        path('/dashboard/welcome') +
          '?guildId=' +
          encodeURIComponent(guildId) +
          '&err=' +
          encodeURIComponent('Select a channel'),
      );
    if (sess) sess.guildId = guildId;
    const cur = (await getWelcomeConfig(discordClient, guildId)) || {};
    const patch = { ...cur };
    if (kind === 'welcome') {
      if (cur.channelId || cur.enabled || (cur.welcomeMessage || '').trim()) {
        return res.redirect(
          path('/dashboard/welcome') +
            '?guildId=' +
            encodeURIComponent(guildId) +
            '&err=' +
            encodeURIComponent('Welcome already configured'),
        );
      }
      patch.enabled = true;
      patch.channelId = channelId;
      patch.welcomeStyle = style;
      patch.welcomeMessage = cur.welcomeMessage || DEFAULT_BANORANT_WELCOME;
    } else if (kind === 'goodbye') {
      if (cur.goodbyeChannelId || cur.goodbyeEnabled || (cur.leaveMessage || '').trim()) {
        return res.redirect(
          path('/dashboard/welcome') +
            '?guildId=' +
            encodeURIComponent(guildId) +
            '&err=' +
            encodeURIComponent('Goodbye already configured'),
        );
      }
      patch.goodbyeEnabled = true;
      patch.goodbyeChannelId = channelId;
      patch.goodbyeStyle = style === 'text' ? 'text' : 'embed';
      patch.leaveMessage = cur.leaveMessage || DEFAULT_BANORANT_GOODBYE;
    } else {
      return res.redirect(path('/dashboard/welcome') + '?err=' + encodeURIComponent('Unknown kind'));
    }
    await saveWelcomeConfig(discordClient, guildId, patch);
    return res.redirect(path('/dashboard/welcome') + '?saved=1&guildId=' + encodeURIComponent(guildId));
  } catch (e) {
    return res.redirect(path('/dashboard/welcome') + '?err=' + encodeURIComponent(e.message || 'Add failed'));
  }
});

app.post(path('/dashboard/welcome/delete'), requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const token = getCookie(req, 'yuri_dash');
    const sess = sessions.get(token) || {};
    const guildId = String(req.body.guildId || sess.guildId || process.env.GUILD_ID || '').trim();
    const kind = String(req.body.kind || '');
    if (!guildId) return res.redirect(path('/dashboard/welcome') + '?err=' + encodeURIComponent('No server'));
    const cur = (await getWelcomeConfig(discordClient, guildId)) || {};
    const patch = { ...cur };
    if (kind === 'welcome') {
      patch.enabled = false;
      patch.channelId = null;
      patch.welcomeMessage = '';
      patch.welcomeStyle = 'text';
    } else if (kind === 'goodbye') {
      patch.goodbyeEnabled = false;
      patch.goodbyeChannelId = null;
      patch.leaveMessage = '';
      patch.goodbyeStyle = 'embed';
    } else {
      return res.redirect(path('/dashboard/welcome') + '?err=' + encodeURIComponent('Unknown kind'));
    }
    await saveWelcomeConfig(discordClient, guildId, patch);
    return res.redirect(
      path('/dashboard/welcome') +
        '?deleted=' +
        encodeURIComponent(kind) +
        '&guildId=' +
        encodeURIComponent(guildId),
    );
  } catch (e) {
    return res.redirect(path('/dashboard/welcome') + '?err=' + encodeURIComponent(e.message || 'Delete failed'));
  }
});

app.post(path('/dashboard/welcome'), requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const token = getCookie(req, 'yuri_dash');
    const sess = sessions.get(token) || {};
    const guildId = String(req.body.guildId || sess.guildId || process.env.GUILD_ID || '').trim();
    if (!guildId) {
      return res.redirect(path('/dashboard/welcome') + '?err=' + encodeURIComponent('No server selected'));
    }
    if (sess) sess.guildId = guildId;
    const loadDefaults = req.body.loadDefaults === '1';
    const wStyle = String(req.body.welcomeStyle || 'text').toLowerCase() === 'embed' ? 'embed' : 'text';
    const gStyle = String(req.body.goodbyeStyle || 'embed').toLowerCase() === 'text' ? 'text' : 'embed';
    const patch = {
      enabled: req.body.enabled === '1',
      channelId: String(req.body.channelId || '').trim() || null,
      welcomeStyle: wStyle,
      welcomeMessage: loadDefaults
        ? DEFAULT_BANORANT_WELCOME
        : String(req.body.welcomeMessage || '').slice(0, 4000),
      goodbyeEnabled: req.body.goodbyeEnabled === '1',
      goodbyeChannelId: String(req.body.goodbyeChannelId || '').trim() || null,
      goodbyeStyle: gStyle,
      leaveMessage: loadDefaults
        ? DEFAULT_BANORANT_GOODBYE
        : String(req.body.leaveMessage || '').slice(0, 4000),
    };
    await saveWelcomeConfig(discordClient, guildId, patch);
    return res.redirect(path('/dashboard/welcome') + '?saved=1&guildId=' + encodeURIComponent(guildId));
  } catch (e) {
    return res.redirect(path('/dashboard/welcome') + '?err=' + encodeURIComponent(e.message || 'Save failed'));
  }
});




// ——— Message editor (bot-owned messages) ———
app.get(path('/dashboard/messages'), requireAuth, async (req, res) => {
  if (req.dashRole === 'guild_admin') {
    return res.status(403).send(layoutFor(req, 'Forbidden', '<p class="err">Owner only.</p>', ''));
  }
  const flash = req.query.ok
    ? `<p class="ok">${escapeHtml(String(req.query.ok))}</p>`
    : req.query.err
      ? `<p class="err">${escapeHtml(String(req.query.err))}</p>`
      : '';
  res.send(
    layoutFor(
      req,
      'Edit messages',
      `<h1 class="section-title">Edit bot messages</h1>
      ${flash}
      <div class="card">
        <p class="muted">Paste a message link or channel ID + message ID. Only messages <strong>sent by this bot</strong> can be edited.</p>
        <form method="post" action="${path('/dashboard/messages/edit')}">
          <label>Message link (or leave blank and use IDs below)</label>
          <input type="text" name="link" placeholder="https://discord.com/channels/guild/channel/message" style="width:100%;margin-bottom:10px"/>
          <label>Channel ID</label>
          <input type="text" name="channelId" style="width:100%;margin-bottom:10px"/>
          <label>Message ID</label>
          <input type="text" name="messageId" style="width:100%;margin-bottom:10px"/>
          <label>New content (text only — embeds kept if present)</label>
          <textarea name="content" rows="8" style="width:100%" required></textarea>
          <div style="margin-top:12px"><button class="btn" type="submit">Edit message</button></div>
        </form>
      </div>`,
      'messages',
    ),
  );
});

app.post(path('/dashboard/messages/edit'), requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    if (req.dashRole === 'guild_admin') {
      return res.redirect(path('/dashboard/messages') + '?err=' + encodeURIComponent('Owner only'));
    }
    let channelId = String(req.body.channelId || '').trim();
    let messageId = String(req.body.messageId || '').trim();
    const link = String(req.body.link || '').trim();
    const content = String(req.body.content || '').slice(0, 2000);
    if (link) {
      const m = link.match(/channels\/\d+\/(\d+)\/(\d+)/);
      if (m) {
        channelId = m[1];
        messageId = m[2];
      }
    }
    if (!channelId || !messageId || !content) {
      return res.redirect(path('/dashboard/messages') + '?err=' + encodeURIComponent('Missing channel/message/content'));
    }
    const ch = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased?.()) {
      return res.redirect(path('/dashboard/messages') + '?err=' + encodeURIComponent('Invalid channel'));
    }
    const msg = await ch.messages.fetch(messageId).catch(() => null);
    if (!msg) {
      return res.redirect(path('/dashboard/messages') + '?err=' + encodeURIComponent('Message not found'));
    }
    if (msg.author?.id !== discordClient.user?.id) {
      return res.redirect(path('/dashboard/messages') + '?err=' + encodeURIComponent('Not a message from this bot'));
    }
    await msg.edit({ content });
    return res.redirect(path('/dashboard/messages') + '?ok=' + encodeURIComponent('Message updated'));
  } catch (e) {
    return res.redirect(path('/dashboard/messages') + '?err=' + encodeURIComponent(e.message || 'Edit failed'));
  }
});

// ——— Server-owner registration (limited dashboard) ———
app.get(path('/register'), async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token || !discordClient?.db) {
    return res.send(layout('Register', '<p class="err">Invalid invite.</p>', 'login'));
  }
  const inv = await discordClient.db.get(`dashboard:invite:${token}`, null);
  if (!inv || inv.used) {
    return res.send(layout('Register', '<p class="err">Invite expired or already used.</p>', 'login'));
  }
  res.send(
    layout(
      'Register',
      `<div class="login-screen"><div class="login-card">
        <div class="brand">Yuri's Chamber<span>Server manager signup</span></div>
        <p class="muted">Guild: <strong>${escapeHtml(inv.guildName || inv.guildId)}</strong></p>
        <p class="muted">You can manage commands &amp; welcome for <em>your server only</em>.</p>
        <form method="POST" action="${path('/register')}" autocomplete="off">
          <input type="hidden" name="token" value="${escapeHtml(token)}"/>
          <label>Username</label>
          <input name="username" required style="width:100%;margin-bottom:10px"/>
          <label>Password</label>
          <input type="password" name="password" required minlength="6" style="width:100%;margin-bottom:12px"/>
          <button class="btn" type="submit">Create account</button>
        </form>
      </div></div>`,
      'login',
    ),
  );
});

app.post(path('/register'), express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!token || !username || password.length < 6) {
      return res.status(400).send('Invalid form');
    }
    const inv = await discordClient.db.get(`dashboard:invite:${token}`, null);
    if (!inv || inv.used) return res.status(400).send('Invite invalid');
    const exists = await discordClient.db.get(`dashboard:user:${username}`, null);
    if (exists) return res.status(400).send('Username taken');
    const cryptoNode = await import('crypto');
    const hash = cryptoNode.createHash('sha256').update(password + ':' + username).digest('hex');
    await discordClient.db.set(`dashboard:user:${username}`, {
      username,
      passwordHash: hash,
      role: 'guild_admin',
      guildIds: [inv.guildId],
      discordUserId: inv.ownerId || null,
      createdAt: Date.now(),
    });
    inv.used = true;
    await discordClient.db.set(`dashboard:invite:${token}`, inv);
    const sess = createSession({
      role: 'guild_admin',
      guildId: inv.guildId,
      allowedGuilds: [inv.guildId],
      userId: username,
    });
    setSessionCookie(res, sess);
    return res.redirect(303, path('/dashboard'));
  } catch (e) {
    return res.status(500).send(String(e.message || e));
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
