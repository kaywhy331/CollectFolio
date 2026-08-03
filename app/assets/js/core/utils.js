const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => escapeMap[character]);
}

export function escapeAttribute(value = '') {
  return escapeHTML(value).replace(/`/g, '&#96;');
}

export function safeImageUrl(value = '') {
  const url = String(value).trim();
  if (url.startsWith('data:image/')) return url;
  try {
    const parsed = new URL(url, location.href);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

export function formatCurrency(value, currency = 'USD') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(Number(value) || 0);
}

export function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? '+' : ''}${number.toFixed(1)}%` : '—';
}

export function formatDate(value, fallback = 'Not recorded') {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? fallback : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

export function normalizeQuery(value = '') {
  return String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function textSimilarity(left = '', right = '') {
  const a = normalizeQuery(left);
  const b = normalizeQuery(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const tokensA = new Set(a.split(' '));
  const tokensB = new Set(b.split(' '));
  const overlap = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  const tokenScore = union ? overlap / union : 0;
  const grams = (text) => new Set([...Array(Math.max(1, text.length - 2))].map((_, index) => text.slice(index, index + 3)));
  const gramsA = grams(a);
  const gramsB = grams(b);
  const gramOverlap = [...gramsA].filter((gram) => gramsB.has(gram)).length;
  const gramScore = (2 * gramOverlap) / (gramsA.size + gramsB.size);
  return Math.max(tokenScore, (tokenScore * 0.55) + (gramScore * 0.45));
}

export async function fetchJSON(url, options = {}, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: options.signal || controller.signal });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function createId() {
  return globalThis.crypto?.randomUUID?.() || `cf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function debounce(callback, wait = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), wait);
  };
}

export function downloadFile(name, contents, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function dataUrlBytes(value = '') {
  const content = String(value).split(',')[1] || '';
  return Math.ceil(content.length * 0.75);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
