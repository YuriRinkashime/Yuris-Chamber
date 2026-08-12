/**
 * Per-guild verification options (ages / genders / ranks).
 * Stored in Mongo: guild:{guildId}:verifyConfig
 */
const DEFAULT_AGES = [
  { label: '13-17', value: 'age_13_17', roleName: '13-17', emoji: '🟢' },
  { label: '18-23', value: 'age_18_23', roleName: '18-23', emoji: '🟡' },
  { label: '24+', value: 'age_24', roleName: '24+', emoji: '🔴' },
];

const DEFAULT_GENDERS = [
  { label: 'Male', value: 'gender_male', roleName: 'Male', emoji: '♂️' },
  { label: 'Female', value: 'gender_female', roleName: 'Female', emoji: '♀️' },
  { label: 'Non-binary / Other', value: 'gender_other', roleName: 'Non-binary / Other', emoji: '🌈' },
];

const DEFAULT_RANKS = [
  {
    label: "Doesn't Play Valo",
    value: 'rank_no_valo',
    roleName: "Doesn't Play Valo",
    emoji: '🎮',
    description: 'Here for other games / hangout',
  },
  { label: 'Unranked', value: 'rank_unranked', roleName: 'Unranked', emoji: '❔' },
  { label: 'Iron', value: 'rank_iron', roleName: 'Iron', emoji: '⚫' },
  { label: 'Bronze', value: 'rank_bronze', roleName: 'Bronze', emoji: '🟤' },
  { label: 'Silver', value: 'rank_silver', roleName: 'Silver', emoji: '⚪' },
  { label: 'Gold', value: 'rank_gold', roleName: 'Gold', emoji: '🟡' },
  { label: 'Platinum', value: 'rank_platinum', roleName: 'Platinum', emoji: '🔵' },
  { label: 'Diamond', value: 'rank_diamond', roleName: 'Diamond', emoji: '💎' },
  { label: 'Ascendant', value: 'rank_ascendant', roleName: 'Ascendant', emoji: '🟢' },
  { label: 'Immortal', value: 'rank_immortal', roleName: 'Immortal', emoji: '🔴' },
  { label: 'Radiant', value: 'rank_radiant', roleName: 'Radiant', emoji: '✨' },
];

function key(guildId) {
  return `guild:${guildId}:verifyConfig`;
}

function normalizeList(list, fallback) {
  if (!Array.isArray(list) || !list.length) return fallback.map((x) => ({ ...x }));
  return list
    .map((o) => ({
      label: String(o.label || o.roleName || '').slice(0, 100),
      value: String(o.value || '').slice(0, 100),
      roleName: String(o.roleName || o.label || '').slice(0, 100),
      emoji: o.emoji || undefined,
      description: o.description ? String(o.description).slice(0, 100) : undefined,
    }))
    .filter((o) => o.label && o.value && o.roleName)
    .slice(0, 25); // Discord select max
}

export function getDefaultVerifyConfig() {
  return {
    ages: DEFAULT_AGES.map((x) => ({ ...x })),
    genders: DEFAULT_GENDERS.map((x) => ({ ...x })),
    ranks: DEFAULT_RANKS.map((x) => ({ ...x })),
    panelTitle: '✅ Server Verification',
    panelDescription:
      'Welcome to **BANORANT CAFE**!\n\n' +
      'Complete these **3 steps** to unlock the server:\n' +
      '**1.** Age\n**2.** Gender\n**3.** Rank / activity (Valorant rank, Unranked, or other games)\n\n' +
      'Select your **age** below to start.',
  };
}

export async function getVerifyConfig(client, guildId) {
  const raw = (await client.db?.get(key(guildId), null)) || null;
  const def = getDefaultVerifyConfig();
  if (!raw) return def;
  return {
    ages: normalizeList(raw.ages, def.ages),
    genders: normalizeList(raw.genders, def.genders),
    ranks: normalizeList(raw.ranks, def.ranks),
    panelTitle: raw.panelTitle || def.panelTitle,
    panelDescription: raw.panelDescription || def.panelDescription,
  };
}

export async function saveVerifyConfig(client, guildId, partial) {
  const cur = await getVerifyConfig(client, guildId);
  const next = {
    ...cur,
    ...partial,
    ages: partial.ages ? normalizeList(partial.ages, cur.ages) : cur.ages,
    genders: partial.genders ? normalizeList(partial.genders, cur.genders) : cur.genders,
    ranks: partial.ranks ? normalizeList(partial.ranks, cur.ranks) : cur.ranks,
    updatedAt: Date.now(),
  };
  await client.db.set(key(guildId), next);
  return next;
}

export async function resetVerifyConfig(client, guildId) {
  const def = getDefaultVerifyConfig();
  await client.db.set(key(guildId), { ...def, updatedAt: Date.now() });
  return def;
}

export function buildRoleMap(config) {
  const map = {};
  for (const list of [config.ages, config.genders, config.ranks]) {
    for (const o of list) map[o.value] = o.roleName;
  }
  return map;
}

export function slugValue(prefix, name) {
  return (
    prefix +
    '_' +
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 80)
  );
}
