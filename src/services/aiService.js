import { logger } from '../utils/logger.js';

const DEFAULT_INSTRUCTIONS =
  "You are Yuri, the AI for BANORANT PH — a Filipino Valorant Discord. Be helpful, casual, Gen Z energy, use light slang and emojis when it fits.";

const HISTORY_LIMIT = 12;

function provider() {
  return (process.env.AI_PROVIDER || 'naga').toLowerCase();
}

function defaultModel() {
  if (provider() === 'gemini') return 'gemini-2.0-flash';
  if (provider() === 'openai') return 'gpt-4o-mini';
  return 'llama-3.3-70b-instruct:free';
}

export async function getAiConfig(client, guildId) {
  const key = `guild:${guildId}:ai`;
  const data = (await client.db?.get(key, null)) || null;
  return {
    enabled: data?.enabled ?? process.env.AI_ENABLED === 'true',
    systemInstructions: data?.systemInstructions || DEFAULT_INSTRUCTIONS,
    model: data?.model || defaultModel(),
    maxReplyLength: data?.maxReplyLength || 1800,
  };
}

export async function saveAiConfig(client, guildId, partial) {
  const current = await getAiConfig(client, guildId);
  const next = { ...current, ...partial, updatedAt: Date.now() };
  await client.db.set(`guild:${guildId}:ai`, next);
  return next;
}

function historyKey(guildId, userId) {
  return `guild:${guildId}:ai:history:${userId}`;
}

function dmHistoryKey(userId) {
  return `dm:ai:history:${userId}`;
}

export async function getUserAiHistory(client, guildId, userId) {
  const data = (await client.db.get(historyKey(guildId, userId), null)) || null;
  return Array.isArray(data?.messages) ? data.messages : [];
}

export async function saveUserAiHistory(client, guildId, userId, messages) {
  const trimmed = messages.slice(-HISTORY_LIMIT);
  await client.db.set(historyKey(guildId, userId), {
    messages: trimmed,
    updatedAt: Date.now(),
  });
  return trimmed;
}

export async function clearUserAiHistory(client, guildId, userId) {
  if (typeof client.db.delete === 'function') {
    await client.db.delete(historyKey(guildId, userId));
  } else {
    await client.db.set(historyKey(guildId, userId), {
      messages: [],
      updatedAt: Date.now(),
    });
  }
}

function prefsKey(guildId, userId) {
  return `guild:${guildId}:ai:prefs:${userId}`;
}

export async function getUserAiPrefs(client, guildId, userId) {
  return (
    (await client.db.get(prefsKey(guildId, userId), null)) || {
      language: null,
      customStyle: null,
    }
  );
}

export async function saveUserAiPrefs(client, guildId, userId, partial) {
  const cur = await getUserAiPrefs(client, guildId, userId);
  const next = { ...cur, ...partial, updatedAt: Date.now() };
  await client.db.set(prefsKey(guildId, userId), next);
  return next;
}

export async function buildSystemInstructions(client, guildId, userId, baseInstructions) {
  const prefs = await getUserAiPrefs(client, guildId, userId);
  const parts = [baseInstructions || DEFAULT_INSTRUCTIONS];

  if (prefs.language === 'ceb') {
    parts.push(
      'USER LANGUAGE PREFERENCE: Reply primarily in Bisaya/Cebuano. Do NOT ask again if they already confirmed.',
    );
  } else if (prefs.language === 'tl') {
    parts.push(
      'USER LANGUAGE PREFERENCE: Reply primarily in Tagalog/Filipino. Do NOT ask again if they already confirmed.',
    );
  } else if (prefs.language === 'en') {
    parts.push(
      'USER LANGUAGE PREFERENCE: Reply primarily in English. Do NOT ask again if they already confirmed.',
    );
  }

  if (prefs.customStyle && String(prefs.customStyle).trim()) {
    parts.push(
      `PERSONAL AI CUSTOMIZATION FOR THIS USER ONLY:\n${String(prefs.customStyle).slice(0, 800)}`,
    );
  }

  return parts.join('\n\n');
}

/** Level + roles from every server the bot shares with this user */
export async function buildUserServerContext(client, userId) {
  const bits = [];

  for (const guild of client.guilds.cache.values()) {
    let member = guild.members.cache.get(userId);
    if (!member) {
      member = await guild.members.fetch(userId).catch(() => null);
    }
    if (!member) continue;

    const roles = [...member.roles.cache.values()]
      .filter((r) => r.id !== guild.id)
      .map((r) => r.name)
      .slice(0, 15);

    let level = 0;
    try {
      const { getUserLevelData } = await import('./leveling/leveling.js');
      const data = await getUserLevelData(client, guild.id, userId);
      level = data?.level || 0;
    } catch (_) {}

    bits.push(
      `Server "${guild.name}": displayName=${member.displayName}; level=${level}; roles=${roles.join(', ') || 'none'}`,
    );
  }

  return bits.length
    ? `Known server data for this user:\n${bits.join('\n')}`
    : 'No shared server data found for this user.';
}

/** Merge DM history + per-guild /prompt history */
export async function getMergedAiHistory(client, userId) {
  const all = [];
  const seen = new Set();

  const push = (arr) => {
    for (const m of arr || []) {
      const t = m.parts?.map((p) => p.text).join('') || '';
      const k = `${m.role}:${t.slice(0, 100)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(m);
    }
  };

  try {
    const dmData = (await client.db.get(dmHistoryKey(userId), null)) || null;
    push(Array.isArray(dmData?.messages) ? dmData.messages : []);
  } catch (_) {}

  for (const guild of client.guilds.cache.values()) {
    try {
      const h = await getUserAiHistory(client, guild.id, userId);
      push(h);
    } catch (_) {}
  }

  return all.slice(-HISTORY_LIMIT);
}

export async function saveDmAiHistory(client, userId, messages) {
  const trimmed = messages.slice(-HISTORY_LIMIT);
  await client.db.set(dmHistoryKey(userId), {
    messages: trimmed,
    updatedAt: Date.now(),
  });
  return trimmed;
}

export async function clearDmAiHistory(client, userId) {
  if (typeof client.db.delete === 'function') {
    await client.db.delete(dmHistoryKey(userId));
  } else {
    await client.db.set(dmHistoryKey(userId), {
      messages: [],
      updatedAt: Date.now(),
    });
  }
}

/**
 * Use this for ALL DM AI (button, auto-5min, dashboard).
 * Loads history + server profile, generates, saves DM history.
 */
export async function generateDmReply(client, userId, userMessage) {
  const guildId = process.env.GUILD_ID;
  const config = await getAiConfig(client, guildId);
  if (!config.enabled) {
    throw new Error('AI is disabled in the dashboard.');
  }

  const lower = String(userMessage || '').toLowerCase();

  if (
    /\b(bisaya|cebuano)\b/i.test(userMessage) &&
    /\b(yes|oo|sige|please|from now|bet|go|bro yes)\b/i.test(lower)
  ) {
    await saveUserAiPrefs(client, guildId, userId, { language: 'ceb' });
  } else if (
    /\b(tagalog|filipino)\b/i.test(userMessage) &&
    /\b(yes|oo|sige|please|from now|bet|go)\b/i.test(lower)
  ) {
    await saveUserAiPrefs(client, guildId, userId, { language: 'tl' });
  } else if (
    /\b(english)\b/i.test(userMessage) &&
    /\b(yes|please|from now|bet|go)\b/i.test(lower)
  ) {
    await saveUserAiPrefs(client, guildId, userId, { language: 'en' });
  } else if (/^(yes|yeah|yep|oo|sige|bro yes|bet)\b/i.test(lower.trim())) {
    const prefs = await getUserAiPrefs(client, guildId, userId);
    if (!prefs.language) {
      await saveUserAiPrefs(client, guildId, userId, { language: 'ceb' });
    }
  }

  if (/\b(personal(ize)?|custom(ize)?|be my ai)\b/i.test(lower)) {
    await saveUserAiPrefs(client, guildId, userId, {
      customStyle: String(userMessage).slice(0, 800),
    });
  }
  if (/\b(reset (style|personality|ai)|default yuri|normal mode)\b/i.test(lower)) {
    await saveUserAiPrefs(client, guildId, userId, { customStyle: null });
  }

  const history = await getMergedAiHistory(client, userId);
  const serverCtx = await buildUserServerContext(client, userId);

  const systemInstructions = await buildSystemInstructions(
    client,
    guildId,
    userId,
    (config.systemInstructions || DEFAULT_INSTRUCTIONS) +
      `\n\nYou are in a private DM as Yuri for BANORANT PH.` +
      `\n${serverCtx}` +
      `\nUse the conversation history. Do not re-ask language preference if already set.` +
      `\nBe short, friendly, Gen Z. Remember what THIS user already told you.`,
  );

  let answer = await generateReply({
    systemInstructions,
    userMessage: String(userMessage).slice(0, 1500),
    model: config.model,
    history,
  });

  const maxLen = config.maxReplyLength || 1800;
  if (answer.length > maxLen) answer = answer.slice(0, maxLen - 3) + '...';
  if (answer.length > 1800) answer = answer.slice(0, 1800) + '...';

  await saveDmAiHistory(client, userId, [
    ...history,
    { role: 'user', parts: [{ text: String(userMessage).slice(0, 1500) }] },
    { role: 'model', parts: [{ text: answer }] },
  ]);

  return answer;
}

function historyToOpenAI(history) {
  return (history || []).map((item) => {
    const role = item.role === 'model' ? 'assistant' : 'user';
    const text = item.parts?.map((p) => p.text).join('') || '';
    return { role, content: text };
  });
}

async function generateOpenAICompatible({
  systemInstructions,
  userMessage,
  model,
  history,
  apiKey,
  baseUrl,
  label,
}) {
  if (!apiKey) throw new Error(`${label} API key is not set`);

  const messages = [
    { role: 'system', content: systemInstructions },
    ...historyToOpenAI(history || []),
    { role: 'user', content: userMessage },
  ];

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || defaultModel(),
      messages,
      max_tokens: 512,
      temperature: 0.7,
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    logger.error(`${label} error:`, raw);
    if (res.status === 429) throw new Error(`${label} rate-limited. Wait a bit.`);
    if (res.status === 401) throw new Error(`${label} key invalid.`);
    throw new Error(`${label} request failed (${res.status})`);
  }

  const json = JSON.parse(raw);
  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`Empty response from ${label}`);
  return text;
}

export async function generateReply(opts) {
  const p = provider();

  if (p === 'naga') {
    return generateOpenAICompatible({
      ...opts,
      apiKey: process.env.NAGA_API_KEY || process.env.OPENAI_API_KEY,
      baseUrl: 'https://api.naga.ac/v1',
      label: 'Naga',
    });
  }

  if (p === 'openai') {
    return generateOpenAICompatible({
      ...opts,
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: 'https://api.openai.com/v1',
      label: 'OpenAI',
    });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const model = opts.model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    system_instruction: { parts: [{ text: opts.systemInstructions }] },
    contents: [
      ...(opts.history || []),
      { role: 'user', parts: [{ text: opts.userMessage }] },
    ],
    generationConfig: { maxOutputTokens: 512, temperature: 0.7 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const errText = await res.text();
  if (!res.ok) {
    logger.error('Gemini error:', errText);
    throw new Error(`Gemini failed (${res.status})`);
  }
  const json = JSON.parse(errText);
  return (
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ||
    'No response'
  ).trim();
}
