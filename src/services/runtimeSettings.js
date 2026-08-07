const KEY = (guildId) => `guild:${guildId}:runtime`;

const state = {
  maintenanceMode: process.env.MAINTENANCE_MODE === 'true',
  maintenanceMessage:
    process.env.MAINTENANCE_MESSAGE ||
    'Bot is under maintenance, all commands has been disabled. Please wait for the bot to online.',
  startedAt: Date.now(),
};

export function getBotStartedAt() {
  return state.startedAt;
}

export function formatUptime(ms = Date.now() - state.startedAt) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  if (m || h || d) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

export function isMaintenanceModeRuntime() {
  return Boolean(state.maintenanceMode);
}

export function getMaintenanceMessage() {
  return state.maintenanceMessage;
}

export async function loadRuntimeSettings(client, guildId) {
  if (!client?.db || !guildId) return { ...state };
  const data = (await client.db.get(KEY(guildId), null)) || {};
  if (typeof data.maintenanceMode === 'boolean') {
    state.maintenanceMode = data.maintenanceMode;
  }
  if (typeof data.maintenanceMessage === 'string' && data.maintenanceMessage.trim()) {
    state.maintenanceMessage = data.maintenanceMessage.trim();
  }
  return { ...state };
}

export async function saveRuntimeSettings(client, guildId, partial) {
  if (typeof partial.maintenanceMode === 'boolean') {
    state.maintenanceMode = partial.maintenanceMode;
  }
  if (typeof partial.maintenanceMessage === 'string') {
    state.maintenanceMessage = partial.maintenanceMessage.slice(0, 500);
  }
  const toSave = {
    maintenanceMode: state.maintenanceMode,
    maintenanceMessage: state.maintenanceMessage,
    updatedAt: Date.now(),
  };
  if (client?.db && guildId) {
    await client.db.set(KEY(guildId), toSave);
  }
  return { ...state };
}
