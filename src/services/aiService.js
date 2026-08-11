import { logger } from '../utils/logger.js';

const DEFAULT_INSTRUCTIONS =
  "You are Yuri, the AI for BANORANT CAFE 🎮 — a Filipino Valorant Discord. Chill, nonchalant, short replies. Light slang ok. Sparse emojis. Never write the placeholder text USER_ID.";

const HISTORY_LIMIT = 12;

/** Catalog of selectable models (dashboard default + /aimodel) */
export const AI_MODELS = [
  {
    id: 'cosmosrp-2.1',
    label: 'CosmosRP V2.1 (Vision · Roleplay)',
    provider: 'pawan',
    model: 'cosmosrp',
    vision: true,
    free: true,
    note: 'Pawan.Krd — vision + RP optimized',
  },
  {
    id: 'gemma-4-26b-free',
    label: 'Gemma 4 26B A4B (Free · OpenRouter)',
    provider: 'openrouter',
    model: 'google/gemma-4-26b-a4b-it:free',
    vision: true,
    free: true,
    note: 'OpenRouter free tier — multimodal',
  },
  {
    id: 'naga-llama-free',
    label: 'Llama 3.3 70B (Naga free)',
    provider: 'naga',
    model: 'llama-3.3-70b-instruct:free',
    vision: false,
    free: true,
    note: 'Text only',
  },
  {
    id: 'openai-gpt-4o-mini',
    label: 'GPT-4o mini (OpenAI)',
    provider: 'openai',
    model: 'gpt-4o-mini',
    vision: true,
    free: false,
    note: 'Requires OPENAI_API_KEY',
  },
  {
    id: 'gemini-flash',
    label: 'Gemini 2.0 Flash',
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    vision: true,
    free: false,
    note: 'Requires GEMINI_API_KEY',
  },
];

export function listAiModels() {
  return AI_MODELS.map(({ id, label, vision, free, note, provider }) => ({
    id,
    label,
    vision,
    free,
    note,
    provider,
  }));
}

export function findAiModel(idOrName) {
  if (!idOrName) return null;
  const q = String(idOrName).trim().toLowerCase();
  return (
    AI_MODELS.find((m) => m.id.toLowerCase() === q) ||
    AI_MODELS.find((m) => m.model.toLowerCase() === q) ||
    AI_MODELS.find((m) => m.label.toLowerCase().includes(q)) ||
    null
  );
}

function defaultModelId() {
  const fromEnv = process.env.AI_DEFAULT_MODEL_ID;
  if (fromEnv && findAiModel(fromEnv)) return fromEnv;
  // Prefer vision-capable free models
  return 'cosmosrp-2.1';
}


function provider() {
  return (process.env.AI_PROVIDER || 'naga').toLowerCase();
}

function defaultModel() {
  const m = findAiModel(defaultModelId());
  return m?.model || 'llama-3.3-70b-instruct:free';
}

export async function getAiConfig(client, guildId) {
  const key = `guild:${guildId}:ai`;
  const data = (await client.db?.get(key, null)) || null;
  const modelId = data?.modelId || defaultModelId();
  const catalog = findAiModel(modelId) || findAiModel(data?.model) || findAiModel(defaultModelId());
  return {
    enabled: data?.enabled ?? process.env.AI_ENABLED === 'true',
    systemInstructions: data?.systemInstructions || DEFAULT_INSTRUCTIONS,
    modelId: catalog?.id || modelId,
    model: catalog?.model || data?.model || defaultModel(),
    provider: catalog?.provider || provider(),
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
    updatedAt: Date.now() });
  return trimmed;
}

export async function clearUserAiHistory(client, guildId, userId) {
  if (typeof client.db.delete === 'function') {
    await client.db.delete(historyKey(guildId, userId));
  } else {
    await client.db.set(historyKey(guildId, userId), {
      messages: [],
      updatedAt: Date.now() });
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
      modelId: null, // null = use server default
    }
  );
}

/** Resolve which catalog model a user should use (user override → server default) */
export async function resolveUserModel(client, guildId, userId) {
  const prefs = await getUserAiPrefs(client, guildId, userId);
  const guild = await getAiConfig(client, guildId);
  const chosen =
    findAiModel(prefs.modelId) ||
    findAiModel(guild.modelId) ||
    findAiModel(guild.model) ||
    findAiModel(defaultModelId()) ||
    AI_MODELS[0];
  return chosen;
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
    updatedAt: Date.now() });
  return trimmed;
}

export async function clearDmAiHistory(client, userId) {
  if (typeof client.db.delete === 'function') {
    await client.db.delete(dmHistoryKey(userId));
  } else {
    await client.db.set(dmHistoryKey(userId), {
      messages: [],
      updatedAt: Date.now() });
  }
}

/**
 * Use this for ALL DM AI (button, auto-5min, dashboard).
 * Loads history + server profile, generates, saves DM history.
 */
function fixAiMentions(text, userId) {
  if (!text) return text;
  const id = String(userId);
  let out = String(text);
  // common model failures
  out = out.replace(/<@!?USER_ID>/gi, `<@${id}>`);
  out = out.replace(/@USER_ID\b/gi, `<@${id}>`);
  out = out.replace(/\{USER_ID\}/gi, id);
  out = out.replace(/\bUSER_ID\b/g, id);
  // bare snowflake → mention (not already in <@...>)
  out = out.replace(/(^|[^<@\w])(\d{17,20})\b/g, (full, pre, snow) => {
    if (snow === id) return `${pre}<@${id}>`;
    return full;
  });
  out = out.replace(/(^|[^<])@(\d{17,20})\b/g, (_, a, sid) => `${a}<@${sid}>`);
  return out;
}

export function formatMediaContext(mediaList = []) {
  const lines = [];
  for (const m of mediaList || []) {
    const u = m.url || m;
    if (!u) continue;
    const ct = String(m.contentType || '').toLowerCase();
    const low = String(u).toLowerCase();
    const isGif =
      ct.includes('gif') ||
      /\.gif(\?|$)/i.test(low) ||
      /tenor\.|giphy\.|klipy\./i.test(low);
    const isVid =
      ct.startsWith('video') || /\.(mp4|webm|mov)(\?|$)/i.test(low);
    if (isVid) lines.push(`[User sent a video: ${u}]`);
    else if (isGif) lines.push(`[User sent a GIF: ${u}]`);
    else lines.push(`[User sent a photo/image: ${u}]`);
  }
  return lines.join('\n');
}

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

  let imageUrls = [];
  let mediaNote = '';
  try {
    const { getThread } = await import('./dmInboxService.js');
    const thread = await getThread(client, userId);
    const recent = (thread.messages || []).slice(-8);
    const media = [];
    for (const m of recent) {
      if (m.from === 'user' && Array.isArray(m.media)) media.push(...m.media);
    }
    const lastUser = [...recent].reverse().find((m) => m.from === 'user');
    if (lastUser?.content) {
      const urls = String(lastUser.content).match(/https?:\/\/[^\s]+/gi) || [];
      for (const u of urls) {
        if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(u) || /tenor\.|giphy\.|klipy\.|discordapp/i.test(u)) {
          media.push({ url: u, contentType: 'image/gif' });
        }
      }
    }
    imageUrls = [...new Set(media.map((m) => m.url).filter(Boolean))].slice(-4);
    mediaNote = formatMediaContext(media.slice(-4));
  } catch (_) {}

  let userMsg = String(userMessage || '').slice(0, 1500);
  if (mediaNote) {
    userMsg =
      (userMsg ? userMsg + '\n\n' : '') +
      mediaNote +
      '\n(React to the photo/GIF when relevant — describe what you see.)';
  }
  if (!userMsg.trim()) userMsg = mediaNote || 'Hello';

  const systemInstructions = await buildSystemInstructions(
    client,
    guildId,
    userId,
    (config.systemInstructions || DEFAULT_INSTRUCTIONS) +
      `\n\nYou are in a private DM as Yuri for BANORANT CAFE.` +
      `\n${serverCtx}` +
      `\nUse the conversation history. Do not re-ask language preference if already set.` +
      `\nBe natural, chill, slightly nonchalant Gen Z. Remember EVERYTHING THIS user already told you in history. Never mix other users.` +
      `\nWhen the user sends photos or GIFs, react to them specifically.` +
      `\n\nThe DM user id is ${userId}. To mention them write exactly <@${userId}>. Never output USER_ID.`,
  );

  const chosen = await resolveUserModel(client, guildId, userId);
  let answer = await generateReply({
    systemInstructions,
    userMessage: userMsg,
    model: chosen.model,
    modelId: chosen.id,
    provider: chosen.provider,
    history,
    imageUrls: chosen.vision ? imageUrls : [],
  });

  const maxLen = config.maxReplyLength || 1800;
  if (answer.length > maxLen) answer = answer.slice(0, maxLen - 3) + '...';
  answer = fixAiMentions(answer, userId);
  if (answer.length > 1800) answer = answer.slice(0, 1800) + '...';

  await saveDmAiHistory(client, userId, [
    ...history,
    { role: 'user', parts: [{ text: userMsg.slice(0, 1500) }] },
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

function buildUserContent(userMessage, imageUrls = []) {
  const urls = (imageUrls || []).filter(Boolean).slice(0, 4);
  if (!urls.length) return userMessage;
  // OpenAI-compatible multimodal
  const parts = [{ type: 'text', text: String(userMessage || 'What is in this image?') }];
  for (const url of urls) {
    parts.push({ type: 'image_url', image_url: { url: String(url) } });
  }
  return parts;
}

async function generateOpenAICompatible({
  systemInstructions,
  userMessage,
  model,
  history,
  imageUrls,
  apiKey,
  baseUrl,
  label,
  extraHeaders = {},
}) {
  if (!apiKey) throw new Error(`${label} API key is not set`);

  const messages = [
    { role: 'system', content: systemInstructions },
    ...historyToOpenAI(history || []),
    { role: 'user', content: buildUserContent(userMessage, imageUrls) },
  ];

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
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
    // Fallback: retry text-only if vision rejected
    if (imageUrls?.length && (res.status === 400 || res.status === 422 || /image|vision|multimodal/i.test(raw))) {
      logger.warn(`${label}: vision not supported by model — retrying text-only with media description`);
      return generateOpenAICompatible({
        systemInstructions,
        userMessage,
        model,
        history,
        imageUrls: [],
        apiKey,
        baseUrl,
        label,
      });
    }
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
  const imageUrls = opts.imageUrls || [];
  // opts.modelId or opts.model → catalog entry; falls back to env provider
  const catalog =
    findAiModel(opts.modelId) ||
    findAiModel(opts.model) ||
    null;
  const p = (opts.provider || catalog?.provider || provider()).toLowerCase();
  const modelName = catalog?.model || opts.model || defaultModel();

  if (p === 'pawan' || p === 'cosmosrp') {
    return generateOpenAICompatible({
      ...opts,
      model: modelName || 'cosmosrp',
      imageUrls: catalog?.vision === false ? [] : imageUrls,
      apiKey: process.env.PAWAN_API_KEY || process.env.COSMOSRP_API_KEY || 'pk-no-key',
      baseUrl: process.env.PAWAN_BASE_URL || 'https://api.pawan.krd/cosmosrp/v1',
      label: 'CosmosRP',
    });
  }

  if (p === 'openrouter') {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('OPENROUTER_API_KEY is not set (needed for OpenRouter models)');
    return generateOpenAICompatible({
      ...opts,
      model: modelName,
      imageUrls: catalog?.vision === false ? [] : imageUrls,
      apiKey: key,
      baseUrl: 'https://openrouter.ai/api/v1',
      label: 'OpenRouter',
      extraHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://yuris-chamber.local',
        'X-Title': process.env.OPENROUTER_SITE_NAME || "Yuri's Chamber",
      },
    });
  }

  if (p === 'naga') {
    return generateOpenAICompatible({
      ...opts,
      model: modelName,
      imageUrls: catalog?.vision === false ? [] : imageUrls,
      apiKey: process.env.NAGA_API_KEY || process.env.OPENAI_API_KEY,
      baseUrl: 'https://api.naga.ac/v1',
      label: 'Naga',
    });
  }

  if (p === 'openai') {
    return generateOpenAICompatible({
      ...opts,
      model: modelName,
      imageUrls,
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: 'https://api.openai.com/v1',
      label: 'OpenAI',
    });
  }

  if (p === 'gemini') {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    const model = modelName || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const userParts = [{ text: opts.userMessage }];
    if (imageUrls.length) {
      userParts[0].text +=
        '\n\n' +
        imageUrls.map((u) => `Image URL: ${u}`).join('\n') +
        '\nDescribe / react to the image if you can.';
    }
    const body = {
      system_instruction: { parts: [{ text: opts.systemInstructions }] },
      contents: [...(opts.history || []), { role: 'user', parts: userParts }],
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
      json?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') ||
      'No response'
    ).trim();
  }

  throw new Error(`Unknown AI provider: ${p}`);
}
