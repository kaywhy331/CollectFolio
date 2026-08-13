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
  return {
    ...box,
    x: Math.round(box.x * scaleX),
    y: Math.round(box.y * scaleY),
    width: Math.round(box.width * scaleX),
    height: Math.round(box.height * scaleY),
    corners: box.corners?.map((point) => ({
      x: Math.round(point.x * scaleX),
      y: Math.round(point.y * scaleY)
    }))
  };
}

export function polygonArea(points = []) {
  if (points.length < 3) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += current.x * next.y - next.x * current.y;
  }
  return total / 2;
}

export function orderQuad(points = []) {
  if (points.length !== 4) throw new Error('A card quadrilateral requires four corners.');
  const center = points.reduce((result, point) => ({ x: result.x + point.x / 4, y: result.y + point.y / 4 }), { x: 0, y: 0 });
  const ordered = points.map((point) => ({ x: Number(point.x), y: Number(point.y) }))
    .sort((left, right) => Math.atan2(left.y - center.y, left.x - center.x) - Math.atan2(right.y - center.y, right.x - center.x));
  const start = ordered.reduce((best, point, index) => point.x + point.y < ordered[best].x + ordered[best].y ? index : best, 0);
  const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
  return polygonArea(rotated) < 0 ? [rotated[0], rotated[3], rotated[2], rotated[1]] : rotated;
}

export function quadBox(points = []) {
  const corners = orderQuad(points);
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.max(...xs) - x),
    height: Math.round(Math.max(...ys) - y),
    corners
  };
}

export function insetQuad(points, width, height, ratio = 0.018) {
  const corners = orderQuad(points);
  const center = corners.reduce((result, point) => ({ x: result.x + point.x / 4, y: result.y + point.y / 4 }), { x: 0, y: 0 });
  const expanded = corners.map((point) => ({
    x: clamp(point.x + (point.x - center.x) * ratio, 0, width - 1),
    y: clamp(point.y + (point.y - center.y) * ratio, 0, height - 1)
  }));
  return orderQuad(expanded);
}

function distance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

export function cardDestinationSize(points, maximumWidth = 1200) {
  let corners = orderQuad(points);
  const horizontal = (distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2;
  const vertical = (distance(corners[0], corners[3]) + distance(corners[1], corners[2])) / 2;
  if (horizontal > vertical) corners = [corners[1], corners[2], corners[3], corners[0]];
  const sourceWidth = Math.max(1, (distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2);
  const sourceHeight = Math.max(1, (distance(corners[0], corners[3]) + distance(corners[1], corners[2])) / 2);
  const scale = Math.min(1, maximumWidth / sourceWidth);
  return {
    corners,
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

export function solveLinearSystem(matrix, values) {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) throw new Error('Card corners do not form a usable perspective transform.');
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index++) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index++) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[size]);
}

export function perspectiveTransform(from, to) {
  if (from.length !== 4 || to.length !== 4) throw new Error('Perspective transforms require four corresponding points.');
  const source = from.map((point) => ({ x: Number(point.x), y: Number(point.y) }));
  const destination = to.map((point) => ({ x: Number(point.x), y: Number(point.y) }));
  const matrix = [];
  const values = [];
  for (let index = 0; index < 4; index++) {
    const { x, y } = source[index];
    const target = destination[index];
    matrix.push([x, y, 1, 0, 0, 0, -target.x * x, -target.x * y]);
    values.push(target.x);
    matrix.push([0, 0, 0, x, y, 1, -target.y * x, -target.y * y]);
    values.push(target.y);
  }
  return [...solveLinearSystem(matrix, values), 1];
}

export function projectPoint(matrix, point) {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-10) return { x: NaN, y: NaN };
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator
  };
}

function grayscaleAndEdges(image) {
  const { width, height, data } = image;
  const gray = new Uint8Array(width * height);
  for (let index = 0; index < gray.length; index++) {
    const offset = index * 4;
    gray[index] = Math.round(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
  }
  const blurred = new Uint8Array(gray.length);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    let total = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) total += gray[(y + dy) * width + x + dx];
    blurred[y * width + x] = Math.round(total / 9);
  }
  const magnitude = new Uint16Array(gray.length);
  const orientation = new Uint8Array(gray.length);
  const histogram = new Uint32Array(1021);
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const offset = y * width + x;
    const gx = -blurred[offset - width - 1] + blurred[offset - width + 1]
      - 2 * blurred[offset - 1] + 2 * blurred[offset + 1]
      - blurred[offset + width - 1] + blurred[offset + width + 1];
    const gy = -blurred[offset - width - 1] - 2 * blurred[offset - width] - blurred[offset - width + 1]
      + blurred[offset + width - 1] + 2 * blurred[offset + width] + blurred[offset + width + 1];
    const value = Math.min(1020, Math.round(Math.hypot(gx, gy)));
    magnitude[offset] = value;
    let angle = Math.atan2(gy, gx);
    if (angle < 0) angle += Math.PI;
    if (angle >= Math.PI) angle -= Math.PI;
    orientation[offset] = Math.min(89, Math.round(angle * 90 / Math.PI) % 90);
    histogram[value]++;
  }
  const populated = Math.max(1, (width - 4) * (height - 4));
  let cumulative = 0;
  let threshold = 96;
  for (let value = histogram.length - 1; value >= 0; value--) {
    cumulative += histogram[value];
    if (cumulative >= populated * 0.075) { threshold = Math.max(54, value); break; }
  }
  const edges = new Uint8Array(gray.length);
  for (let index = 0; index < magnitude.length; index++) edges[index] = magnitude[index] >= threshold ? 1 : 0;
  return { edges, magnitude, orientation, threshold };
}

function angleDistance(left, right) {
  const delta = Math.abs(left - right) % Math.PI;
  return Math.min(delta, Math.PI - delta);
}

function houghLines(edges, magnitude, orientation, width, height, options = {}) {
  const thetaStep = Math.PI / 90;
  const thetaCount = 90;
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoCount = diagonal * 2 + 1;
  const accumulator = new Float32Array(thetaCount * rhoCount);
  const cosines = new Float32Array(thetaCount);
  const sines = new Float32Array(thetaCount);
  for (let theta = 0; theta < thetaCount; theta++) {
    cosines[theta] = Math.cos(theta * thetaStep);
    sines[theta] = Math.sin(theta * thetaStep);
  }
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 650));
  for (let y = 2; y < height - 2; y += stride) for (let x = 2; x < width - 2; x += stride) {
    const index = y * width + x;
    if (!edges[index]) continue;
    const weight = Math.min(4, 1 + magnitude[index] / 255);
    const center = orientation[index];
    for (let delta = -3; delta <= 3; delta++) {
      const theta = (center + delta + thetaCount) % thetaCount;
      const rho = Math.round(x * cosines[theta] + y * sines[theta]) + diagonal;
      accumulator[theta * rhoCount + rho] += weight;
    }
  }
  const minimumVotes = Math.max(18, Math.min(width, height) * 0.08 / stride);
  const peaks = [];
  for (let theta = 0; theta < thetaCount; theta++) for (let rho = 1; rho < rhoCount - 1; rho++) {
    const votes = accumulator[theta * rhoCount + rho];
    if (votes < minimumVotes || votes < accumulator[theta * rhoCount + rho - 1] || votes < accumulator[theta * rhoCount + rho + 1]) continue;
    peaks.push({ theta: theta * thetaStep, rho: rho - diagonal, votes });
  }
  peaks.sort((left, right) => right.votes - left.votes);
  const retained = [];
  for (const line of peaks) {
    if (retained.some((other) => angleDistance(line.theta, other.theta) < thetaStep * 2.2 && Math.abs(line.rho - other.rho) < Math.max(7, Math.min(width, height) * 0.014))) continue;
    retained.push(line);
    if (retained.length >= (options.maximumHoughLines ?? 48)) break;
  }
  return retained;
}

function lineIntersection(left, right) {
  const a = Math.cos(left.theta); const b = Math.sin(left.theta);
  const c = Math.cos(right.theta); const d = Math.sin(right.theta);
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 0.08) return null;
  return {
    x: (left.rho * d - b * right.rho) / determinant,
    y: (a * right.rho - left.rho * c) / determinant
  };
}

function quadIoU(left, right) {
  const a = quadBox(left);
  const b = quadBox(right);
  const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlap = overlapWidth * overlapHeight;
  return overlap / Math.max(1, a.width * a.height + b.width * b.height - overlap);
}

function sampleRGB(image, x, y) {
  const xx = clamp(Math.round(x), 0, image.width - 1);
  const yy = clamp(Math.round(y), 0, image.height - 1);
  const offset = (yy * image.width + xx) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function quadrilateralBoundaryScore(image, magnitude, points) {
  const corners = orderQuad(points);
  const sampleDistance = Math.max(2, Math.min(image.width, image.height) * 0.009);
  const sideScores = [];
  for (let side = 0; side < 4; side++) {
    const start = corners[side];
    const end = corners[(side + 1) % 4];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const inwardX = -dy / length;
    const inwardY = dx / length;
    let contrast = 0;
    let edge = 0;
    let samples = 0;
    for (let step = 2; step <= 18; step++) {
      const ratio = step / 20;
      const x = start.x + dx * ratio;
      const y = start.y + dy * ratio;
      const inside = sampleRGB(image, x + inwardX * sampleDistance, y + inwardY * sampleDistance);
      const outside = sampleRGB(image, x - inwardX * sampleDistance, y - inwardY * sampleDistance);
      contrast += Math.hypot(inside[0] - outside[0], inside[1] - outside[1], inside[2] - outside[2]) / 441.7;
      let strongest = 0;
      for (let normal = -2; normal <= 2; normal++) {
        const xx = clamp(Math.round(x + inwardX * normal), 0, image.width - 1);
        const yy = clamp(Math.round(y + inwardY * normal), 0, image.height - 1);
        strongest = Math.max(strongest, magnitude[yy * image.width + xx] / 1020);
      }
      edge += strongest;
      samples++;
    }
    sideScores.push(samples ? (contrast / samples) * 0.58 + (edge / samples) * 0.42 : 0);
  }
  const mean = sideScores.reduce((total, score) => total + score, 0) / sideScores.length;
  const weakest = Math.min(...sideScores);
  return Math.max(0, Math.min(1, mean * 0.72 + weakest * 0.28));
}

function quadrilateralCandidates(image, options = {}) {
  const { width, height } = image;
  const { edges, magnitude, orientation } = grayscaleAndEdges(image);
  const lines = houghLines(edges, magnitude, orientation, width, height, options);
  const minimumSeparation = Math.min(width, height) * 0.22;
  const maximumSeparation = Math.hypot(width, height) * 0.92;
  const pairs = [];
  for (let left = 0; left < lines.length; left++) for (let right = left + 1; right < lines.length; right++) {
    const angle = angleDistance(lines[left].theta, lines[right].theta);
    const separation = Math.abs(lines[left].rho - lines[right].rho);
    if (angle > Math.PI / 14 || separation < minimumSeparation || separation > maximumSeparation) continue;
    pairs.push({ lines: [lines[left], lines[right]], angle: (lines[left].theta + lines[right].theta) / 2, votes: lines[left].votes + lines[right].votes, separation });
  }
  pairs.sort((left, right) => right.votes - left.votes);
  const candidates = [];
  const usablePairs = pairs.slice(0, 42);
  for (let firstIndex = 0; firstIndex < usablePairs.length; firstIndex++) for (let secondIndex = firstIndex + 1; secondIndex < usablePairs.length; secondIndex++) {
    const first = usablePairs[firstIndex];
    const second = usablePairs[secondIndex];
    const orthogonal = angleDistance(first.angle, second.angle);
    if (orthogonal < Math.PI * 0.36 || orthogonal > Math.PI * 0.64) continue;
    const raw = [
      lineIntersection(first.lines[0], second.lines[0]),
      lineIntersection(first.lines[1], second.lines[0]),
      lineIntersection(first.lines[1], second.lines[1]),
      lineIntersection(first.lines[0], second.lines[1])
    ];
    if (raw.some((point) => !point)) continue;
    const marginX = width * 0.08; const marginY = height * 0.08;
    if (raw.some((point) => point.x < -marginX || point.y < -marginY || point.x > width + marginX || point.y > height + marginY)) continue;
    const corners = orderQuad(raw.map((point) => ({ x: clamp(point.x, 0, width - 1), y: clamp(point.y, 0, height - 1) })));
    const area = Math.abs(polygonArea(corners));
    const areaRatio = area / (width * height);
    if (areaRatio < (options.minimumCardArea ?? 0.075) || areaRatio > 0.94) continue;
    const top = distance(corners[0], corners[1]); const right = distance(corners[1], corners[2]);
    const bottom = distance(corners[2], corners[3]); const left = distance(corners[3], corners[0]);
    const short = Math.min((top + bottom) / 2, (left + right) / 2);
    const long = Math.max((top + bottom) / 2, (left + right) / 2);
    const aspect = long / Math.max(1, short);
    if (aspect < 1.12 || aspect > 2.05) continue;
    const aspectScore = Math.max(0, 1 - Math.abs(aspect - 1.43) / 0.72);
    const angleScore = Math.max(0, 1 - Math.abs(orthogonal - Math.PI / 2) / (Math.PI * 0.18));
    const voteScale = Math.max(1, Math.min(width, height) * 2.2);
    const lineScore = Math.min(1, (first.votes + second.votes) / voteScale);
    const areaScore = Math.min(1, areaRatio / 0.32);
    const boundaryScore = quadrilateralBoundaryScore(image, magnitude, corners);
    const frameMargin = Math.min(...corners.flatMap((point) => [point.x, point.y, width - 1 - point.x, height - 1 - point.y]));
    const framePenalty = frameMargin < Math.min(width, height) * 0.008 ? 0.2 : 0;
    const confidence = Math.max(0, Math.min(1,
      boundaryScore * 0.44 + lineScore * 0.2 + aspectScore * 0.17 + angleScore * 0.13 + areaScore * 0.06 - framePenalty
    ));
    candidates.push({ corners, confidence, area, method: 'adaptive-quad', fallback: false });
  }
  candidates.sort((left, right) => right.confidence - left.confidence || right.area - left.area);
  const retained = [];
  for (const candidate of candidates) {
    if (candidate.confidence < (options.minimumQuadConfidence ?? 0.3) || retained.some((other) => quadIoU(candidate.corners, other.corners) > 0.58)) continue;
    retained.push(candidate);
    if (retained.length >= (options.maximumCards ?? 24)) break;
  }
  return retained;
}

function axisAlignedCandidates(image, options = {}) {
  const first = createForegroundMask(image, options);
  const closed = erode(dilate(first, image.width, image.height, options.dilateRadius ?? 2), image.width, image.height, options.erodeRadius ?? 1);
  const components = connectedComponents(closed, image.width, image.height);
  return mergeBoxes(filterComponents(components, image.width, image.height, options), options.mergeGap ?? Math.max(3, Math.floor(Math.min(image.width, image.height) * 0.012)))
    .map((box) => expandBox(box, image.width, image.height, options.expand ?? 0.025))
    .filter((box) => box.width * box.height < image.width * image.height * 0.9)
    .map((box) => ({
      ...box,
      corners: [
        { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
      ],
      confidence: 0.42,
      method: 'foreground-component',
      fallback: false
    }));
}

export function detectBoundaries(image, options = {}) {
  const quads = quadrilateralCandidates(image, options);
  const axis = axisAlignedCandidates(image, options);
  const combined = [...quads, ...axis].sort((left, right) => right.confidence - left.confidence || left.y - right.y || left.x - right.x);
  const retained = [];
  for (const candidate of combined) {
    if (retained.some((other) => quadIoU(candidate.corners, other.corners) > 0.58)) continue;
    const corners = insetQuad(candidate.corners, image.width, image.height, options.expand ?? 0.018);
    retained.push({ ...quadBox(corners), confidence: candidate.confidence, method: candidate.method, fallback: false });
  }
  if (retained.length) return retained.sort((left, right) => left.y - right.y || left.x - right.x);
  const insetX = Math.max(1, Math.round(image.width * 0.025));
  const insetY = Math.max(1, Math.round(image.height * 0.025));
  const fallback = {
    x: insetX,
    y: insetY,
    width: Math.max(1, image.width - insetX * 2),
    height: Math.max(1, image.height - insetY * 2),
    corners: [
      { x: insetX, y: insetY }, { x: image.width - insetX, y: insetY },
      { x: image.width - insetX, y: image.height - insetY }, { x: insetX, y: image.height - insetY }
    ],
    confidence: 0,
    method: 'manual-fallback',
    fallback: true
  };
  return [fallback];
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
