import { clamp } from '../core/utils.js';

export function estimateBackground(image) {
  const { width, height, data } = image;
  const size = Math.max(1, Math.floor(Math.min(width, height) * 0.08));
  const samples = [];
  const corners = [[0, 0], [width - size, 0], [0, height - size], [width - size, height - size]];
  for (const [startX, startY] of corners) {
    for (let y = startY; y < startY + size; y += Math.max(1, Math.floor(size / 6))) {
      for (let x = startX; x < startX + size; x += Math.max(1, Math.floor(size / 6))) {
        const index = (y * width + x) * 4;
        samples.push([data[index], data[index + 1], data[index + 2]]);
      }
    }
  }
  const channel = (index) => samples.map((sample) => sample[index]).sort((a, b) => a - b)[Math.floor(samples.length / 2)] || 0;
  return [channel(0), channel(1), channel(2)];
}

export function createForegroundMask(image, options = {}) {
  const { width, height, data } = image;
  const background = options.background || estimateBackground(image);
  const distanceThreshold = options.distanceThreshold ?? 38;
  const gradientThreshold = options.gradientThreshold ?? 27;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const dr = data[offset] - background[0];
      const dg = data[offset + 1] - background[1];
      const db = data[offset + 2] - background[2];
      const distance = Math.sqrt(dr * dr + dg * dg + db * db);
      let gradient = 0;
      if (x > 0) {
        const other = offset - 4;
        gradient = Math.max(gradient, Math.abs(data[offset] - data[other]) + Math.abs(data[offset + 1] - data[other + 1]) + Math.abs(data[offset + 2] - data[other + 2]));
      }
      if (y > 0) {
        const other = offset - width * 4;
        gradient = Math.max(gradient, Math.abs(data[offset] - data[other]) + Math.abs(data[offset + 1] - data[other + 1]) + Math.abs(data[offset + 2] - data[other + 2]));
      }
      mask[y * width + x] = distance >= distanceThreshold || gradient >= gradientThreshold * 3 ? 1 : 0;
    }
  }
  return mask;
}

export function dilate(mask, width, height, radius = 1) {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 0;
    for (let dy = -radius; dy <= radius && !value; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < width && yy < height && mask[yy * width + xx]) { value = 1; break; }
    }
    output[y * width + x] = value;
  }
  return output;
}

export function erode(mask, width, height, radius = 1) {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 1;
    for (let dy = -radius; dy <= radius && value; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height || !mask[yy * width + xx]) { value = 0; break; }
    }
    output[y * width + x] = value;
  }
  return output;
}

export function connectedComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    visited[start] = 1;
    const queue = [start];
    let head = 0;
    let minX = width, minY = height, maxX = 0, maxY = 0, area = 0;
    while (head < queue.length) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); area++;
      for (const next of [index - 1, index + 1, index - width, index + width]) {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        const nextX = next % width;
        if (Math.abs(nextX - x) + Math.abs(Math.floor(next / width) - y) !== 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    components.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area });
  }
  return components;
}

export function filterComponents(components, width, height, options = {}) {
  const imageArea = width * height;
  const minArea = options.minArea ?? imageArea * 0.012;
  const maxArea = options.maxArea ?? imageArea * 0.96;
  return components.filter((box) => {
    const ratio = box.width / Math.max(box.height, 1);
    const fill = box.area / (box.width * box.height);
    return box.area >= minArea && box.area <= maxArea && ratio >= (options.minAspect ?? 0.35) && ratio <= (options.maxAspect ?? 2.2) && fill >= (options.minFill ?? 0.09);
  });
}

function intersection(a, b, padding = 0) {
  const left = Math.max(a.x - padding, b.x - padding);
  const top = Math.max(a.y - padding, b.y - padding);
  const right = Math.min(a.x + a.width + padding, b.x + b.width + padding);
  const bottom = Math.min(a.y + a.height + padding, b.y + b.height + padding);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export function mergeBoxes(boxes, gap = 5) {
  const merged = boxes.map((box) => ({ ...box }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i++) for (let j = i + 1; j < merged.length; j++) {
      const overlap = intersection(merged[i], merged[j], gap);
      if (!overlap) continue;
      const a = merged[i];
      const b = merged[j];
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      merged[i] = { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y, area: (a.area || a.width * a.height) + (b.area || b.width * b.height) };
      merged.splice(j, 1);
      changed = true;
      break outer;
    }
  }
  return merged;
}

export function expandBox(box, width, height, percent = 0.025) {
  const expandX = box.width * percent;
  const expandY = box.height * percent;
  const x = clamp(box.x - expandX, 0, width);
  const y = clamp(box.y - expandY, 0, height);
  const right = clamp(box.x + box.width + expandX, 0, width);
  const bottom = clamp(box.y + box.height + expandY, 0, height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
}

export function mapBox(box, scaleX, scaleY) {
  return { x: Math.round(box.x * scaleX), y: Math.round(box.y * scaleY), width: Math.round(box.width * scaleX), height: Math.round(box.height * scaleY) };
}

export function detectBoundaries(image, options = {}) {
  const first = createForegroundMask(image, options);
  const closed = erode(dilate(first, image.width, image.height, options.dilateRadius ?? 2), image.width, image.height, options.erodeRadius ?? 1);
  const components = connectedComponents(closed, image.width, image.height);
  const boxes = mergeBoxes(filterComponents(components, image.width, image.height, options), options.mergeGap ?? Math.max(3, Math.floor(Math.min(image.width, image.height) * 0.012)))
    .map((box) => expandBox(box, image.width, image.height, options.expand ?? 0.025))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return boxes.length ? boxes : [{ x: 0, y: 0, width: image.width, height: image.height }];
}

export function gridBoxes(width, height, rows, columns) {
  const safeRows = clamp(Math.round(rows), 1, 12);
  const safeColumns = clamp(Math.round(columns), 1, 12);
  const boxes = [];
  for (let row = 0; row < safeRows; row++) for (let column = 0; column < safeColumns; column++) {
    const x = Math.round((column * width) / safeColumns);
    const y = Math.round((row * height) / safeRows);
    const right = Math.round(((column + 1) * width) / safeColumns);
    const bottom = Math.round(((row + 1) * height) / safeRows);
    boxes.push({ x, y, width: right - x, height: bottom - y });
  }
  return boxes;
}

export function differenceHash(grayscale, width = 9, height = 8) {
  if (width !== 9 || height !== 8 || grayscale.length < width * height) throw new Error('dHash requires a 9×8 grayscale buffer.');
  let bits = '';
  for (let y = 0; y < height; y++) for (let x = 0; x < width - 1; x++) bits += grayscale[y * width + x] > grayscale[y * width + x + 1] ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function hashSimilarity(left, right) {
  if (!left || !right) return 0;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (value) { distance += Number(value & 1n); value >>= 1n; }
  return 1 - distance / 64;
}
