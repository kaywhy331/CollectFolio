import { textSimilarity } from '../core/utils.js';
import { differenceHash, hashSimilarity } from './image-algorithms.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const IMAGE_LOAD_TIMEOUT_MS = 10_000;
const OCR_TIMEOUT_MS = 45_000;
const OCR_MIN_WIDTH = 1200;
const OCR_MAX_WIDTH = 1600;
const OCR_MAX_PIXELS = 3_000_000;
export const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
let tesseractPromise;

const OCR_IGNORED_WORDS = new Set([
  'basic', 'card', 'copyright', 'edition', 'energy', 'hp', 'illustrated', 'illustration',
  'illustrator', 'pokemon', 'pokémon', 'stage', 'trademark', 'trainer'
]);
const OCR_VARIANT_WORDS = new Set(['ex', 'gx', 'lv', 'v', 'vmax', 'vstar']);
const OCR_BOILERPLATE = /(?:copyright|trademark|illustrat(?:ed|ion|or)|\ball rights reserved\b|\bweakness\b|\bresistance\b|\bretreat\b|\bwww\.|©|™)/iu;
const OCR_STAT_LINE = /(?:\b(?:atk|def|hp)\s*\d+\b|\b\d+\s*(?:damage|hp)\b)/iu;
const COLLECTOR_PATTERNS = [
  /(?:^|[\s#])([\p{L}]{0,6}\d{1,4}[\p{L}]?\/[\p{L}]{0,6}\d{1,4}[\p{L}]?)(?=$|\s)/iu,
  /(?:^|\s)([\p{L}]{2,6}\d{0,3}-[\p{L}]{0,4}\d{2,5})(?=$|\s)/iu,
  /^#?([\p{L}]?\d{1,4}[\p{L}]?)$/iu,
  /(?:^|\s)#?(\d{1,4}[\p{L}]?)(?=$|\s)/iu
];

export function withTimeout(promise, timeout, message = 'Operation timed out.') {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.name = 'TimeoutError';
      reject(error);
    }, timeout);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function cleanOCRLine(value = '') {
  return String(value).normalize('NFKC')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}#&/' .:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEvidence(value = '') {
  return String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function extractCollectorNumber(value = '') {
  const lines = String(value).split(/\r?\n/).map(cleanOCRLine).filter(Boolean);
  for (const pattern of COLLECTOR_PATTERNS) {
    for (const line of lines) {
      if (OCR_STAT_LINE.test(line)) continue;
      const match = line.match(pattern);
      const candidate = match?.[1]?.trim();
      if (!candidate || /^(?:19|20)\d{2}$/.test(candidate)) continue;
      return candidate.replace(/^#/, '').slice(0, 40);
    }
  }
  return '';
}

function plausibleWord(token = '') {
  const letters = token.replace(/[^\p{L}]/gu, '');
  if (!letters) return false;
  if (/^(.)\1{2,}$/iu.test(letters) || /^[1il|]+$/iu.test(token)) return false;
  if (OCR_VARIANT_WORDS.has(token.toLowerCase())) return true;
  if (letters.length <= 2) return letters.length === 2;
  if (/[^\x00-\x7f]/.test(letters)) return true;
  return /[aeiouy]/i.test(letters);
}

function titleCandidate(line, index, number) {
  if (!line || OCR_BOILERPLATE.test(line) || OCR_STAT_LINE.test(line)) return null;
  let value = number ? line.replace(number, ' ') : line;
  value = value.replace(/^#/, '').replace(/\s+/g, ' ').trim();
  const rawTokens = value.split(' ').map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'-]+$/gu, '')).filter(Boolean);
  const tokens = rawTokens.filter((token) => !OCR_IGNORED_WORDS.has(token.toLowerCase()) && !/^\d+$/.test(token));
  if (!tokens.length || tokens.length > 7) return null;
  const plausible = tokens.filter(plausibleWord);
  const oneCharacter = tokens.filter((token) => token.replace(/[^\p{L}\p{N}]/gu, '').length <= 1).length;
  const letters = tokens.join('').replace(/[^\p{L}]/gu, '').length;
  const alphanumeric = tokens.join('').replace(/[^\p{L}\p{N}]/gu, '').length;
  if (!plausible.length || oneCharacter > Math.max(1, Math.floor(tokens.length / 3)) || letters < 2) return null;
  if (plausible.length / tokens.length < 0.6 || (alphanumeric && letters / alphanumeric < 0.55)) return null;
  const title = tokens.join(' ').slice(0, 100);
  const compactShape = tokens.length <= 4 ? 12 : tokens.length <= 6 ? 6 : 0;
  const early = Math.max(0, 12 - index * 2);
  const suffix = tokens.some((token) => OCR_VARIANT_WORDS.has(token.toLowerCase())) ? 5 : 0;
  return { title, score: 45 + compactShape + early + suffix + (plausible.length / tokens.length) * 20 };
}

export function buildOCRQueryVariants({ title = '', number = '', alternate = '' } = {}) {
  const primary = [title, number].filter(Boolean).join(' ');
  const relaxed = title.split(' ').length > 1 && OCR_VARIANT_WORDS.has(title.split(' ').at(-1)?.toLowerCase())
    ? title.split(' ').slice(0, -1).join(' ')
    : '';
  const third = alternate && normalizeEvidence(alternate) !== normalizeEvidence(title) ? alternate : relaxed;
  const values = [primary, title, third]
    .map((query) => cleanOCRLine(query).slice(0, 160))
    .filter((query) => query.length >= 2);
  const seen = new Set();
  return values.filter((query) => {
    const normalized = normalizeEvidence(query);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, 3);
}

export function queryEvidenceFromText(value = '') {
  const query = cleanOCRLine(value).slice(0, 160);
  const number = extractCollectorNumber(query);
  const title = cleanOCRLine(number ? query.replace(number, ' ') : query);
  return {
    text: '', accepted: Boolean(query), quality: 1, title: title || query, number,
    queries: buildOCRQueryVariants({ title: title || query, number }), query, reason: ''
  };
}

export function analyzeOCRText(text = '', { confidence = null } = {}) {
  const raw = String(text || '');
  const lines = [...new Set(raw.split(/\r?\n/).map(cleanOCRLine).filter(Boolean))];
  const visibleCharacters = [...raw].filter((character) => !/\s/u.test(character));
  const noisyCharacters = visibleCharacters.filter((character) => !/[\p{L}\p{N}#&/' .:-]/u.test(character));
  const symbolRatio = visibleCharacters.length ? noisyCharacters.length / visibleCharacters.length : 1;
  const number = extractCollectorNumber(lines.join('\n'));
  const candidates = lines.map((line, index) => titleCandidate(line, index, number)).filter(Boolean)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
  const uniqueTitles = [];
  const seenTitles = new Set();
  for (const candidate of candidates) {
    const normalized = normalizeEvidence(candidate.title);
    if (!normalized || seenTitles.has(normalized)) continue;
    seenTitles.add(normalized);
    uniqueTitles.push(candidate);
  }
  const title = uniqueTitles[0]?.title || '';
  const alternate = uniqueTitles.find((candidate) => normalizeEvidence(candidate.title) !== normalizeEvidence(title))?.title || '';
  const numericConfidence = confidence === null || confidence === undefined || confidence === '' ? null : Number(confidence);
  const confidenceAccepted = numericConfidence === null || (Number.isFinite(numericConfidence) && numericConfidence >= 35);
  const repeatedNoise = /([^\s])\1{3,}/iu.test(raw);
  const queries = buildOCRQueryVariants({ title, number, alternate });
  const accepted = Boolean(queries.length && title && confidenceAccepted && symbolRatio <= 0.3 && !repeatedNoise);
  const quality = accepted
    ? Math.max(0, Math.min(1, ((uniqueTitles[0]?.score || 0) / 100) * 0.7 + ((numericConfidence ?? 70) / 100) * 0.3))
    : 0;
  let reason = '';
  if (!raw.trim()) reason = 'No text was detected.';
  else if (!confidenceAccepted) reason = 'The detected text was too uncertain.';
  else if (symbolRatio > 0.3 || repeatedNoise) reason = 'The detected text looked like symbols rather than a card name.';
  else if (!title) reason = 'No reliable card name was detected.';
  return {
    text: raw,
    accepted,
    quality,
    title: accepted ? title : '',
    number: accepted ? number : '',
    queries: accepted ? queries : [],
    query: accepted ? queries[0] : '',
    reason: accepted ? '' : reason || 'No reliable card name was detected.'
  };
}

export function extractOCRQuery(text = '') {
  const result = analyzeOCRText(text);
  return result.query;
}

export function loadImage(source, timeout = IMAGE_LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';
    const cleanup = () => {
      clearTimeout(timer);
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
    };
    const onLoad = () => { cleanup(); resolve(image); };
    const onError = () => { cleanup(); reject(new Error('The image could not be decoded.')); };
    const timer = setTimeout(() => {
      cleanup();
      image.removeAttribute('src');
      reject(new Error(`The image did not load within ${Math.ceil(timeout / 1000)} seconds.`));
    }, timeout);
    image.addEventListener('load', onLoad, { once: true });
    image.addEventListener('error', onError, { once: true });
    image.src = source;
  });
}

export function validateImageFile(file, maximumBytes = MAX_IMAGE_FILE_BYTES) {
  if (!file || !Number.isFinite(Number(file.size)) || Number(file.size) < 0) {
    throw new Error('Choose a valid image file.');
  }
  if (Number(file.size) === 0) throw new Error('The selected image is empty.');
  if (Number(file.size) > maximumBytes) throw new Error('Images must be 25 MB or smaller.');
  return file;
}

export function fileToImageDataURL(file) {
  validateImageFile(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result), { once: true });
    reader.addEventListener('error', () => reject(reader.error || new Error('Could not read the image.')), { once: true });
    reader.readAsDataURL(file);
  });
}

export function cropToJPEG(image, box, maxWidth = 1200, quality = 0.9) {
  const scale = Math.min(1, maxWidth / Math.max(1, box.width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(box.width * scale));
  canvas.height = Math.max(1, Math.round(box.height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(image, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export function cropsFromBoxes(image, boxes) {
  return boxes.map((box) => ({ box: { ...box }, image: cropToJPEG(image, box, 1200, 0.9) }));
}

function otsuThreshold(values) {
  const histogram = new Uint32Array(256);
  values.forEach((value) => histogram[value]++);
  let sum = 0;
  for (let value = 0; value < 256; value++) sum += value * histogram[value];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let maximumVariance = -1;
  let selected = 128;
  for (let value = 0; value < 256; value++) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = values.length - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > maximumVariance) { maximumVariance = variance; selected = value; }
  }
  return selected;
}

function percentile(histogram, total, ratio) {
  const target = total * ratio;
  let count = 0;
  for (let value = 0; value < histogram.length; value++) {
    count += histogram[value];
    if (count >= target) return value;
  }
  return 255;
}

function preprocessOCRRegion(image, { start = 0, end = 1, threshold = false } = {}) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const sourceY = Math.max(0, Math.round(sourceHeight * start));
  const sourceRegionHeight = Math.max(1, Math.round(sourceHeight * (end - start)));
  let scale = Math.min(OCR_MAX_WIDTH / sourceWidth, Math.max(1, OCR_MIN_WIDTH / sourceWidth));
  if (sourceWidth * sourceRegionHeight * scale * scale > OCR_MAX_PIXELS) {
    scale = Math.sqrt(OCR_MAX_PIXELS / (sourceWidth * sourceRegionHeight));
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceRegionHeight * scale));
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, sourceY, sourceWidth, sourceRegionHeight, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const grayscale = new Uint8Array(canvas.width * canvas.height);
  const histogram = new Uint32Array(256);
  for (let index = 0; index < grayscale.length; index++) {
    const offset = index * 4;
    const value = Math.round(pixels.data[offset] * 0.299 + pixels.data[offset + 1] * 0.587 + pixels.data[offset + 2] * 0.114);
    grayscale[index] = value;
    histogram[value]++;
  }
  const low = percentile(histogram, grayscale.length, 0.01);
  const high = Math.max(low + 1, percentile(histogram, grayscale.length, 0.99));
  for (let index = 0; index < grayscale.length; index++) {
    grayscale[index] = Math.max(0, Math.min(255, Math.round((grayscale[index] - low) * 255 / (high - low))));
  }
  const cutoff = threshold ? otsuThreshold(grayscale) : null;
  for (let index = 0; index < grayscale.length; index++) {
    const offset = index * 4;
    const value = threshold ? (grayscale[index] > cutoff ? 255 : 0) : grayscale[index];
    pixels.data[offset] = value;
    pixels.data[offset + 1] = value;
    pixels.data[offset + 2] = value;
    pixels.data[offset + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

export function* createOCRSources(image) {
  yield { label: 'title grayscale', psm: '6', source: preprocessOCRRegion(image, { start: 0.02, end: 0.32 }) };
  yield { label: 'title threshold', psm: '6', source: preprocessOCRRegion(image, { start: 0.02, end: 0.32, threshold: true }) };
  yield { label: 'footer grayscale', psm: '6', source: preprocessOCRRegion(image, { start: 0.68, end: 1 }) };
  yield { label: 'footer threshold', psm: '6', source: preprocessOCRRegion(image, { start: 0.68, end: 1, threshold: true }) };
  yield { label: 'full card', psm: '11', source: preprocessOCRRegion(image) };
}

async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (!window.COLLECTFOLIO_CONFIG?.ENABLE_TESSERACT) throw new Error('External OCR is disabled in runtime configuration.');
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESSERACT_URL;
      script.crossOrigin = 'anonymous';
      script.referrerPolicy = 'no-referrer';
      script.addEventListener('load', () => window.Tesseract
        ? resolve(window.Tesseract)
        : reject(new Error('Tesseract.js loaded without its browser API. Enter a query manually.')), { once: true });
      script.addEventListener('error', () => reject(new Error('Tesseract.js could not be loaded. Enter a query manually.')), { once: true });
      document.head.append(script);
    }).catch((error) => {
      tesseractPromise = null;
      throw error;
    });
  }
  try {
    return await withTimeout(tesseractPromise, 15_000, 'Tesseract.js did not load within 15 seconds. Enter a query manually.');
  } catch (error) {
    // A stalled script never fires its own error event; clear the shared loader
    // so the user's retry can create a fresh request.
    tesseractPromise = null;
    throw error;
  }
}

export async function recognizeText(imageSource) {
  const image = await loadImage(imageSource);
  if ('TextDetector' in window) {
    try {
      const blocks = await new window.TextDetector().detect(image);
      const text = blocks.map((block) => block.rawValue).join('\n');
      const confidences = blocks.map((block) => Number(block.confidence)).filter(Number.isFinite);
      const analysis = analyzeOCRText(text, { confidence: confidences.length ? Math.max(...confidences) * (Math.max(...confidences) <= 1 ? 100 : 1) : null });
      if (analysis.accepted) return { ...analysis, engine: 'TextDetector' };
    } catch {
      // The user explicitly requested OCR, so the configured fallback may run.
    }
  }
  const tesseract = await loadTesseract();
  let worker;
  const recognition = (async () => {
    if (!tesseract.createWorker) {
      const result = await tesseract.recognize(imageSource, 'eng');
      return [{ result, label: 'full card' }];
    }
    worker = await tesseract.createWorker('eng');
    const results = [];
    for (const pass of createOCRSources(image)) {
      if (worker.setParameters) await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: pass.psm });
      results.push({ result: await worker.recognize(pass.source), label: pass.label });
    }
    return results;
  })();
  let passes;
  try {
    passes = await withTimeout(recognition, OCR_TIMEOUT_MS, 'OCR did not finish within 45 seconds. Enter a query manually or retry.');
  } finally {
    if (worker?.terminate) await withTimeout(Promise.resolve(worker.terminate()), 2_000).catch(() => {});
  }
  const texts = [];
  const confidences = [];
  for (const pass of passes || []) {
    const data = pass?.result?.data || pass?.result || {};
    const confidence = Number(data.confidence);
    if (Number.isFinite(confidence)) confidences.push(confidence);
    if (!Number.isFinite(confidence) || confidence >= 25) texts.push(data.text || '');
  }
  const text = [...new Set(texts.flatMap((value) => String(value).split(/\r?\n/)).map((line) => line.trim()).filter(Boolean))].join('\n');
  return { ...analyzeOCRText(text, { confidence: confidences.length ? Math.max(...confidences) : null }), engine: 'Tesseract.js' };
}

export function imageDifferenceHash(image) {
  const canvas = document.createElement('canvas');
  canvas.width = 9; canvas.height = 8;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, 9, 8);
  const pixels = context.getImageData(0, 0, 9, 8).data;
  const grayscale = new Uint8Array(72);
  for (let index = 0; index < 72; index++) grayscale[index] = Math.round(pixels[index * 4] * 0.299 + pixels[index * 4 + 1] * 0.587 + pixels[index * 4 + 2] * 0.114);
  return differenceHash(grayscale);
}

export function candidateEvidenceScore(candidate = {}, evidence = {}) {
  const source = typeof evidence === 'string' ? { query: evidence, title: evidence, number: extractCollectorNumber(evidence) } : evidence;
  const title = source.title || source.query || source.queries?.[0] || '';
  const number = source.number || extractCollectorNumber(source.query || source.queries?.[0] || '');
  const candidateNumber = String(candidate.number || '').trim();
  const titleScore = textSimilarity(title, candidate.name || '');
  const queryScore = textSimilarity(source.query || source.queries?.[0] || title, [candidate.name, candidate.setName, candidate.number].join(' '));
  const normalizedNumber = String(number).replace(/^#/, '').split('/')[0].replace(/[^a-z0-9]/gi, '').toLowerCase().replace(/^0+(?=\d)/, '');
  const normalizedCandidateNumber = candidateNumber.replace(/^#/, '').split('/')[0].replace(/[^a-z0-9]/gi, '').toLowerCase().replace(/^0+(?=\d)/, '');
  const numberAvailable = Boolean(normalizedNumber && normalizedCandidateNumber);
  const numberMatches = numberAvailable && normalizedNumber === normalizedCandidateNumber;
  let score = titleScore * (numberAvailable ? 0.68 : 0.88) + queryScore * 0.12 + (numberMatches ? 0.2 : 0);
  if (numberAvailable && !numberMatches) score = Math.min(score, 0.45);
  return Math.max(0, Math.min(1, score));
}

export async function rerankCandidates(cropSource, candidates, evidence) {
  let cropHash;
  try { cropHash = imageDifferenceHash(await loadImage(cropSource)); } catch { cropHash = ''; }
  return (await Promise.all(candidates.map(async (candidate) => {
    const metadata = candidateEvidenceScore(candidate, evidence);
    const candidateImage = candidate.imageSmall || candidate.image;
    if (!cropHash || !candidateImage) return { ...candidate, matchScore: metadata };
    try {
      const hash = imageDifferenceHash(await loadImage(candidateImage));
      const visualScore = hashSimilarity(cropHash, hash);
      return { ...candidate, visualScore, matchScore: Math.min(1, metadata * 0.88 + visualScore * 0.12) };
    } catch {
      return { ...candidate, matchScore: metadata };
    }
  }))).sort((a, b) => b.matchScore - a.matchScore);
}
