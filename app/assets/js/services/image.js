import { textSimilarity } from '../core/utils.js';
import { differenceHash, hashSimilarity } from './image-algorithms.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let tesseractPromise;

export function extractOCRQuery(text = '') {
  const lines = String(text).normalize('NFKD').split(/\r?\n/).map((line) => line.replace(/[^\p{L}\p{N}#/' -]/gu, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const tokens = lines.flatMap((line) => line.split(' ')).map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}/#-]+$/gu, '')).filter(Boolean);
  const distinctive = tokens.filter((token) => token.length >= 5 && !/^(copyright|trademark|pokemon|illustration|edition)$/i.test(token));
  const numbered = tokens.filter((token) => /\d/.test(token));
  const chosen = [...new Set([...distinctive.slice(0, 5), ...numbered.slice(0, 3)])];
  return (chosen.length ? chosen : tokens.slice(0, 6)).join(' ').slice(0, 160);
}

export function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('The image could not be decoded.')), { once: true });
    image.src = source;
  });
}

export function fileToImageDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result), { once: true });
    reader.addEventListener('error', () => reject(reader.error || new Error('Could not read the image.')), { once: true });
    reader.readAsDataURL(file);
  });
}

export function cropToJPEG(image, box, maxWidth = 720, quality = 0.84) {
  const scale = Math.min(1, maxWidth / Math.max(1, box.width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(box.width * scale));
  canvas.height = Math.max(1, Math.round(box.height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(image, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export function cropsFromBoxes(image, boxes) {
  return boxes.map((box) => ({ box: { ...box }, image: cropToJPEG(image, box, 720, 0.84) }));
}

async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (!window.COLLECTFOLIO_CONFIG?.ENABLE_TESSERACT) throw new Error('External OCR is disabled in runtime configuration.');
  if (!tesseractPromise) tesseractPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TESSERACT_URL;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.addEventListener('load', () => resolve(window.Tesseract), { once: true });
    script.addEventListener('error', () => reject(new Error('Tesseract.js could not be loaded. Enter a query manually.')), { once: true });
    document.head.append(script);
  });
  return tesseractPromise;
}

export async function recognizeText(imageSource) {
  const image = await loadImage(imageSource);
  if ('TextDetector' in window) {
    try {
      const blocks = await new window.TextDetector().detect(image);
      const text = blocks.map((block) => block.rawValue).join('\n');
      return { text, query: extractOCRQuery(text), engine: 'TextDetector' };
    } catch {
      // The user explicitly requested OCR, so the configured fallback may run.
    }
  }
  const tesseract = await loadTesseract();
  const result = await tesseract.recognize(imageSource, 'eng');
  const text = result?.data?.text || '';
  return { text, query: extractOCRQuery(text), engine: 'Tesseract.js' };
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

export async function rerankCandidates(cropSource, candidates, query) {
  let cropHash;
  try { cropHash = imageDifferenceHash(await loadImage(cropSource)); } catch { return candidates; }
  return (await Promise.all(candidates.map(async (candidate) => {
    const metadata = candidate.matchScore ?? textSimilarity(query, [candidate.name, candidate.setName, candidate.number].join(' '));
    try {
      const hash = imageDifferenceHash(await loadImage(candidate.imageSmall || candidate.image));
      return { ...candidate, visualScore: hashSimilarity(cropHash, hash), matchScore: (hashSimilarity(cropHash, hash) * 0.62) + (metadata * 0.38) };
    } catch {
      return { ...candidate, matchScore: metadata };
    }
  }))).sort((a, b) => b.matchScore - a.matchScore);
}
