import { getUserLevelData } from './leveling/leveling.js';
import { getUserAiHistory } from './aiService.js'; // if split file, adjust

/** Build context from all mutual guilds + merge DM + server AI history */
export async function buildUserServerContext(client, userId) {
  const bits = [];

  for (const guild of client.guilds.cache.values()) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;

    const roles = [...member.roles.cache.values()]
      .filter((r) => r.id !== guild.id)
      .map((r) => r.name)
      .slice(0, 15);

    let level = 0;
    try {
      const data = await getUserLevelData(client, guild.id, userId);
      level = data.level || 0;
    } catch (_) {}

    bits.push(
      `Server "${guild.name}": nick=${member.displayName}; level=${level}; roles=${roles.join(', ') || 'none'}`,
    );
  }

  return bits.length
    ? `Known server data for this user:\n${bits.join('\n')}`
    : 'No shared server data found for this user.';
}

export async function getMergedAiHistory(client, userId) {
  // Merge history from every guild the bot shares + a global DM history key
  const all = [];
  const seen = new Set();

  const push = (arr) => {
    for (const m of arr || []) {
      const t = m.parts?.map((p) => p.text).join('') || '';
      const k = `${m.role}:${t.slice(0, 80)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(m);
    }
  };

  // Global DM history
  const dmHist =
    (await client.db.get(`dm:ai:history:${userId}`, null))?.messages || [];
  push(dmHist);

  for (const guild of client.guilds.cache.values()) {
    try {
      const h = await getUserAiHistory(client, guild.id, userId);
      push(h);
    } catch (_) {}
  }

  return all.slice(-50);
}

export async function saveDmAiHistory(client, userId, messages) {
  await client.db.set(`dm:ai:history:${userId}`, {
    messages: messages.slice(-80),
    updatedAt: Date.now(),
  });
}
