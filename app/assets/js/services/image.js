import { textSimilarity } from '../core/utils.js';
import { cardDestinationSize, differenceHash, hashSimilarity, perspectiveTransform, projectPoint } from './image-algorithms.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const IMAGE_LOAD_TIMEOUT_MS = 10_000;
const OCR_TIMEOUT_MS = 45_000;
const OCR_MIN_WIDTH = 1200;
const OCR_MAX_WIDTH = 1600;
const OCR_MAX_PIXELS = 3_000_000;
export const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
let tesseractPromise;
let tesseractWorkerPromise;
let ocrQueue = Promise.resolve();
let ocrWorkerGeneration = 0;

const OCR_IGNORED_WORDS = new Set([
  'basic', 'card', 'copyright', 'edition', 'energy', 'hp', 'illustrated', 'illustration',
  'illustrator', 'pokemon', 'pokémon', 'stage', 'trademark', 'trainer'
]);
const OCR_VARIANT_WORDS = new Set(['ex', 'gx', 'lv', 'v', 'vmax', 'vstar']);
const OCR_SHORT_TITLE_WORDS = new Set(['of', 'to', 'in', 'on', 'at', 'by', 'my', 'no', 'go', 'mr', 'ms', 'dr', 'la', 'de', 'le', 'el', 'un']);
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
  const titleTokens = title.split(' ').filter(Boolean);
  const relaxed = title.split(' ').length > 1 && OCR_VARIANT_WORDS.has(title.split(' ').at(-1)?.toLowerCase())
    ? title.split(' ').slice(0, -1).join(' ')
    : '';
  const withoutShortNoise = titleTokens.length > 1 && titleTokens.some((token) => {
    const letters = token.replace(/[^\p{L}]/gu, '');
    return letters.length === 2 && token === token.toUpperCase()
      && !OCR_VARIANT_WORDS.has(token.toLowerCase()) && !OCR_SHORT_TITLE_WORDS.has(token.toLowerCase());
  })
    ? titleTokens.filter((token) => {
      const letters = token.replace(/[^\p{L}]/gu, '');
      return letters.length !== 2 || token !== token.toUpperCase()
        || OCR_VARIANT_WORDS.has(token.toLowerCase()) || OCR_SHORT_TITLE_WORDS.has(token.toLowerCase());
    }).join(' ')
    : '';
  const distinctAlternate = alternate && normalizeEvidence(alternate) !== normalizeEvidence(title) ? alternate : '';
  const values = [primary, number, title, withoutShortNoise, distinctAlternate, relaxed]
    .map((query) => cleanOCRLine(query).slice(0, 160))
    .filter((query) => query.length >= 2);
  const seen = new Set();
  return values.filter((query) => {
    const normalized = normalizeEvidence(query);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, 6);
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
  const titleTokens = title.split(' ').filter(Boolean);
  const titleLetters = title.replace(/[^\p{L}]/gu, '').length;
  const reliableTitle = title && (titleTokens.length > 1 || titleLetters >= 4) ? title : '';
  const reliableNumber = number && (/[/\-]/.test(number) || numericConfidence === null || numericConfidence >= 55) ? number : '';
  const queries = buildOCRQueryVariants({ title: reliableTitle, number: reliableNumber, alternate });
  const accepted = Boolean(queries.length && (reliableTitle || reliableNumber) && confidenceAccepted && symbolRatio <= 0.3 && !repeatedNoise);
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
    title: accepted ? reliableTitle : '',
    number: accepted ? reliableNumber : '',
    queries: accepted ? queries : [],
    query: accepted ? queries[0] : '',
    reason: accepted ? '' : reason || 'No reliable card name was detected.'
  };
}

function passConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number <= 1 ? number * 100 : number));
}

function fuzzyEvidenceGroup(groups, value) {
  const normalized = normalizeEvidence(value);
  if (!normalized) return null;
  return groups.find((group) => group.values.some((entry) => textSimilarity(normalized, entry.normalized) >= 0.78)) || null;
}

export function analyzeOCRPasses(passes = []) {
  const entries = passes.map((pass) => {
    const data = pass?.result?.data || pass?.result || pass || {};
    const confidence = passConfidence(data.confidence ?? pass?.confidence);
    const analysis = analyzeOCRText(data.text || pass?.text || '', { confidence });
    return { ...pass, confidence, analysis };
  }).filter((entry) => String(entry.analysis.text || '').trim());
  const titleGroups = [];
  const numberGroups = new Map();
  for (const entry of entries) {
    const weight = Math.max(0.2, (entry.confidence ?? 55) / 100);
    if (entry.analysis.title) {
      let group = fuzzyEvidenceGroup(titleGroups, entry.analysis.title);
      if (!group) {
        group = { values: [], weight: 0, passes: 0 };
        titleGroups.push(group);
      }
      group.values.push({ value: entry.analysis.title, normalized: normalizeEvidence(entry.analysis.title), weight });
      group.weight += weight;
      group.passes++;
    }
    if (entry.analysis.number) {
      const normalized = normalizeEvidence(entry.analysis.number);
      const group = numberGroups.get(normalized) || { value: entry.analysis.number, weight: 0, passes: 0 };
      group.weight += weight;
      group.passes++;
      numberGroups.set(normalized, group);
    }
  }
  const titleGroup = titleGroups.sort((left, right) => right.passes - left.passes || right.weight - left.weight)[0];
  const title = titleGroup?.values.sort((left, right) => right.weight - left.weight || right.value.length - left.value.length)[0]?.value || '';
  const alternate = titleGroups.slice(1).flatMap((group) => group.values).sort((left, right) => right.weight - left.weight)[0]?.value || '';
  const number = [...numberGroups.values()].sort((left, right) => right.passes - left.passes || right.weight - left.weight)[0]?.value || '';
  const queries = buildOCRQueryVariants({ title, number, alternate });
  const supporting = entries.filter((entry) =>
    (title && entry.analysis.title && textSimilarity(title, entry.analysis.title) >= 0.78)
    || (number && normalizeEvidence(entry.analysis.number) === normalizeEvidence(number))
  );
  const quality = supporting.length
    ? supporting.reduce((total, entry) => total + (entry.analysis.quality || (entry.confidence ?? 50) / 100), 0) / supporting.length
    : 0;
  const accepted = Boolean(queries.length && (title || number));
  return {
    text: [...new Set(supporting.flatMap((entry) => String(entry.analysis.text).split(/\r?\n/)).map(cleanOCRLine).filter(Boolean))].join('\n'),
    accepted,
    quality: Math.max(0, Math.min(1, quality)),
    title,
    number,
    queries,
    query: queries[0] || '',
    reason: accepted ? '' : entries.map((entry) => entry.analysis.reason).find(Boolean) || 'No reliable card name or collector number was detected.',
    passes: entries.map((entry) => ({
      label: entry.label || '', rotation: Number(entry.rotation) || 0,
      confidence: entry.confidence, accepted: entry.analysis.accepted,
      title: entry.analysis.title, number: entry.analysis.number
    }))
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
  if (box?.corners?.length === 4) return rectifyCardToJPEG(image, box.corners, maxWidth, quality);
  const scale = Math.min(1, maxWidth / Math.max(1, box.width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(box.width * scale));
  canvas.height = Math.max(1, Math.round(box.height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(image, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export function rectifyCardPixels(sourcePixels, sourceWidth, sourceHeight, corners, maximumWidth = 1200) {
  const destination = cardDestinationSize(corners, maximumWidth);
  const targetCorners = [
    { x: 0, y: 0 }, { x: destination.width - 1, y: 0 },
    { x: destination.width - 1, y: destination.height - 1 }, { x: 0, y: destination.height - 1 }
  ];
  const inverse = perspectiveTransform(targetCorners, destination.corners);
  const output = new Uint8ClampedArray(destination.width * destination.height * 4);
  const sample = (x, y, channel) => {
    const xx = Math.max(0, Math.min(sourceWidth - 1, x));
    const yy = Math.max(0, Math.min(sourceHeight - 1, y));
    return sourcePixels[(yy * sourceWidth + xx) * 4 + channel];
  };
  for (let y = 0; y < destination.height; y++) for (let x = 0; x < destination.width; x++) {
    const point = projectPoint(inverse, { x, y });
    const sourceX = Math.max(0, Math.min(sourceWidth - 1, point.x));
    const sourceY = Math.max(0, Math.min(sourceHeight - 1, point.y));
    const x0 = Math.floor(sourceX); const y0 = Math.floor(sourceY);
    const x1 = Math.min(sourceWidth - 1, x0 + 1); const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const dx = sourceX - x0; const dy = sourceY - y0;
    const outputOffset = (y * destination.width + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const top = sample(x0, y0, channel) * (1 - dx) + sample(x1, y0, channel) * dx;
      const bottom = sample(x0, y1, channel) * (1 - dx) + sample(x1, y1, channel) * dx;
      output[outputOffset + channel] = Math.round(top * (1 - dy) + bottom * dy);
    }
    output[outputOffset + 3] = 255;
  }
  return { width: destination.width, height: destination.height, data: output, corners: destination.corners };
}

export function rectifyCardToJPEG(image, corners, maximumWidth = 1200, quality = 0.9) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const source = document.createElement('canvas');
  source.width = sourceWidth;
  source.height = sourceHeight;
  const context = source.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
  const pixels = context.getImageData(0, 0, sourceWidth, sourceHeight);
  const rectified = rectifyCardPixels(pixels.data, sourceWidth, sourceHeight, corners, maximumWidth);
  const output = document.createElement('canvas');
  output.width = rectified.width;
  output.height = rectified.height;
  output.getContext('2d', { alpha: false }).putImageData(new ImageData(rectified.data, rectified.width, rectified.height), 0, 0);
  return output.toDataURL('image/jpeg', quality);
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

function orientedCanvas(image, rotation = 0) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const normalized = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const canvas = document.createElement('canvas');
  canvas.width = normalized % 180 ? sourceHeight : sourceWidth;
  canvas.height = normalized % 180 ? sourceWidth : sourceHeight;
  const context = canvas.getContext('2d', { alpha: false });
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(normalized * Math.PI / 180);
  context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
  return canvas;
}

function preprocessOCRRegion(image, { start = 0, end = 1, threshold = false, rotation = 0 } = {}) {
  const oriented = orientedCanvas(image, rotation);
  const sourceWidth = oriented.width;
  const sourceHeight = oriented.height;
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
  context.drawImage(oriented, 0, sourceY, sourceWidth, sourceRegionHeight, 0, 0, canvas.width, canvas.height);
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

export function* createOrientationOCRSources(image) {
  for (const rotation of [0, 90, 180, 270]) {
    yield { label: 'orientation', rotation, psm: '11', source: preprocessOCRRegion(image, { rotation }) };
  }
}

export function* createOCRSources(image, rotations = [0]) {
  for (const rotation of rotations) {
    yield { label: 'title grayscale', rotation, psm: '6', source: preprocessOCRRegion(image, { start: 0.02, end: 0.32, rotation }) };
    yield { label: 'title threshold', rotation, psm: '6', source: preprocessOCRRegion(image, { start: 0.02, end: 0.32, threshold: true, rotation }) };
    yield { label: 'footer threshold', rotation, psm: '6', source: preprocessOCRRegion(image, { start: 0.68, end: 1, threshold: true, rotation }) };
  }
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

async function sharedTesseractWorker() {
  const tesseract = await loadTesseract();
  if (!tesseract.createWorker) return null;
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = withTimeout(tesseract.createWorker('eng'), 30_000, 'OCR worker did not initialize within 30 seconds.')
      .catch((error) => {
        tesseractWorkerPromise = null;
        throw error;
      });
  }
  return tesseractWorkerPromise;
}

export async function releaseOCRWorker() {
  const pending = tesseractWorkerPromise;
  tesseractWorkerPromise = null;
  ocrWorkerGeneration++;
  if (!pending) return;
  const worker = await pending.catch(() => null);
  if (worker?.terminate) await withTimeout(Promise.resolve(worker.terminate()), 2_000).catch(() => {});
}

async function invalidateOCRWorker(expectedWorker = null) {
  const pending = tesseractWorkerPromise;
  tesseractWorkerPromise = null;
  ocrWorkerGeneration++;
  const worker = expectedWorker || await pending?.catch(() => null);
  if (worker?.terminate) await withTimeout(Promise.resolve(worker.terminate()), 2_000).catch(() => {});
}

function queuedOCR(operation) {
  const next = ocrQueue.catch(() => {}).then(operation);
  ocrQueue = next.catch(() => {});
  return next;
}

export async function recognizeText(imageSource) {
  const image = await loadImage(imageSource);
  if ('TextDetector' in window) {
    try {
      const blocks = await new window.TextDetector().detect(image);
      const text = blocks.map((block) => block.rawValue).join('\n');
      const confidences = blocks.map((block) => Number(block.confidence)).filter(Number.isFinite);
      const analysis = analyzeOCRPasses([{ text, confidence: confidences.length ? Math.max(...confidences) : null, label: 'native', rotation: 0 }]);
      if (analysis.accepted) return { ...analysis, engine: 'TextDetector' };
    } catch {
      // The user explicitly requested OCR, so the configured fallback may run.
    }
  }
  const tesseract = await loadTesseract();
  let worker = null;
  let workerGeneration = ocrWorkerGeneration;
  const recognition = queuedOCR(async () => {
    if (!tesseract.createWorker) {
      const result = await tesseract.recognize(imageSource, 'eng');
      return [{ result, label: 'full card', rotation: 0 }];
    }
    worker = await sharedTesseractWorker();
    workerGeneration = ocrWorkerGeneration;
    const orientationResults = [];
    for (const pass of createOrientationOCRSources(image)) {
      if (worker.setParameters) await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: pass.psm });
      orientationResults.push({ result: await worker.recognize(pass.source), label: pass.label, rotation: pass.rotation });
    }
    const rankedOrientations = orientationResults.map((pass) => {
      const analysis = analyzeOCRPasses([pass]);
      return { rotation: pass.rotation, score: (analysis.accepted ? 1 : 0) + analysis.quality + (analysis.number ? 0.35 : 0) };
    }).sort((left, right) => right.score - left.score || left.rotation - right.rotation);
    const rotation = rankedOrientations[0]?.rotation || 0;
    const targeted = [];
    for (const pass of createOCRSources(image, [rotation])) {
      if (worker.setParameters) await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: pass.psm });
      targeted.push({ result: await worker.recognize(pass.source), label: pass.label, rotation: pass.rotation });
    }
    return [...orientationResults, ...targeted];
  });
  let passes;
  try {
    passes = await withTimeout(recognition, OCR_TIMEOUT_MS, 'OCR did not finish within 45 seconds. Enter a query manually or retry.');
  } catch (error) {
    // A timed-out recognition can continue running inside Tesseract and would
    // otherwise hold the serialized queue forever. Terminate that generation
    // and reset the queue so a user retry starts with a fresh worker.
    if (error?.name === 'TimeoutError' && workerGeneration === ocrWorkerGeneration) {
      ocrQueue = Promise.resolve();
      await invalidateOCRWorker(worker);
    }
    throw error;
  }
  return { ...analyzeOCRPasses(passes), engine: 'Tesseract.js' };
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
  const titleAvailable = Boolean(String(title).trim() && normalizeEvidence(title) !== normalizeEvidence(number));
  let score = titleAvailable
    ? titleScore * (numberAvailable ? 0.68 : 0.88) + queryScore * 0.12 + (numberMatches ? 0.2 : 0)
    : numberMatches ? 0.82 : queryScore * 0.12;
  // A matching collector number is strong recovery evidence even when a title
  // pass contains OCR noise; preserve it for reranking instead of filtering it
  // out before the image tie-breaker can inspect the candidate.
  if (numberMatches) score = Math.max(score, titleAvailable ? 0.62 : 0.82);
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
