const MAX = 100;
const lines = [];

export function pushLog(level, message) {
  const entry = {
    t: Date.now(),
    level: String(level || 'info'),
    message: String(message || '').slice(0, 500),
  };
  lines.push(entry);
  if (lines.length > MAX) lines.shift();
  return entry;
}

export function getLogs(limit = 50) {
  return lines.slice(-limit);
}
