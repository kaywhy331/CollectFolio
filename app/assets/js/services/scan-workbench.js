import { clamp } from '../core/utils.js';
import { detectBoundaries, gridBoxes, mapBox, quadBox } from './image-algorithms.js';

export class ScanWorkbench {
  constructor(canvas, image, { single = false, onChange = () => {}, onStatus = () => {} } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { willReadFrequently: true });
    this.image = image;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.single = single;
    this.detectionWorker = null;
    this.detectionJob = 0;
    this.destroyed = false;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    this.boxes = [this.manualFallback(width, height)];
    this.selected = 0;
    this.mode = 'select';
    this.drag = null;
    this.canvas.width = image.naturalWidth || image.width;
    this.canvas.height = image.naturalHeight || image.height;
    this.bind();
    this.render();
  }

  bind() {
    this.pointerDown = (event) => this.onPointerDown(event);
    this.pointerMove = (event) => this.onPointerMove(event);
    this.pointerUp = (event) => this.onPointerUp(event);
    this.canvas.addEventListener('pointerdown', this.pointerDown);
    this.canvas.addEventListener('pointermove', this.pointerMove);
    this.canvas.addEventListener('pointerup', this.pointerUp);
    this.canvas.addEventListener('pointercancel', this.pointerUp);
  }

  destroy() {
    this.destroyed = true;
    this.detectionJob += 1;
    this.detectionWorker?.terminate();
    this.detectionWorker = null;
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointercancel', this.pointerUp);
  }

  point(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) * this.canvas.width / rect.width, 0, this.canvas.width), y: clamp((event.clientY - rect.top) * this.canvas.height / rect.height, 0, this.canvas.height) };
  }

  hitBox(point) {
    for (let index = this.boxes.length - 1; index >= 0; index--) {
      const box = this.boxes[index];
      if (point.x >= box.x && point.y >= box.y && point.x <= box.x + box.width && point.y <= box.y + box.height) return index;
    }
    return -1;
  }

  isHandle(point, box) {
    const corner = this.hitCorner(point, box);
    if (corner >= 0) return corner;
    const size = Math.max(18, Math.min(this.canvas.width, this.canvas.height) * 0.025);
    return Math.abs(point.x - (box.x + box.width)) <= size && Math.abs(point.y - (box.y + box.height)) <= size ? 2 : -1;
  }

  hitCorner(point, box) {
    if (!box?.corners?.length) return -1;
    const size = Math.max(22, Math.min(this.canvas.width, this.canvas.height) * 0.032);
    return box.corners.findIndex((corner) => Math.hypot(point.x - corner.x, point.y - corner.y) <= size);
  }

  manualFallback(width = this.canvas.width, height = this.canvas.height) {
    const insetX = Math.max(1, Math.round(width * 0.025));
    const insetY = Math.max(1, Math.round(height * 0.025));
    return {
      x: insetX, y: insetY, width: width - insetX * 2, height: height - insetY * 2,
      corners: [
        { x: insetX, y: insetY }, { x: width - insetX, y: insetY },
        { x: width - insetX, y: height - insetY }, { x: insetX, y: height - insetY }
      ],
      confidence: 0, method: 'manual-fallback', fallback: true
    };
  }

  onPointerDown(event) {
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.point(event);
    if (this.mode === 'add') {
      this.boxes.push({
        x: point.x, y: point.y, width: 1, height: 1,
        corners: [{ ...point }, { ...point }, { ...point }, { ...point }],
        confidence: 1, method: 'manual-box', fallback: false
      });
      this.selected = this.boxes.length - 1;
      this.drag = { type: 'draw', start: point };
      this.render();
      return;
    }
    const selectedBox = this.boxes[this.selected];
    const corner = selectedBox ? this.isHandle(point, selectedBox) : -1;
    if (selectedBox && corner >= 0) {
      this.drag = { type: 'corner', corner, start: point, box: structuredClone(selectedBox) };
      return;
    }
    this.selected = this.hitBox(point);
    if (this.selected >= 0) this.drag = { type: 'move', start: point, box: { ...this.boxes[this.selected] } };
    this.render();
  }

  onPointerMove(event) {
    if (!this.drag || this.selected < 0) return;
    event.preventDefault();
    const point = this.point(event);
    const min = Math.max(16, Math.min(this.canvas.width, this.canvas.height) * 0.02);
    if (this.drag.type === 'move') {
      const dx = point.x - this.drag.start.x;
      const dy = point.y - this.drag.start.y;
      const x = clamp(this.drag.box.x + dx, 0, this.canvas.width - this.drag.box.width);
      const y = clamp(this.drag.box.y + dy, 0, this.canvas.height - this.drag.box.height);
      const movedX = x - this.drag.box.x;
      const movedY = y - this.drag.box.y;
      this.boxes[this.selected] = {
        ...this.drag.box, x, y,
        corners: this.drag.box.corners?.map((corner) => ({ x: corner.x + movedX, y: corner.y + movedY }))
      };
    } else if (this.drag.type === 'corner') {
      const corners = this.drag.box.corners?.map((entry) => ({ ...entry })) || [
        { x: this.drag.box.x, y: this.drag.box.y }, { x: this.drag.box.x + this.drag.box.width, y: this.drag.box.y },
        { x: this.drag.box.x + this.drag.box.width, y: this.drag.box.y + this.drag.box.height }, { x: this.drag.box.x, y: this.drag.box.y + this.drag.box.height }
      ];
      corners[this.drag.corner] = point;
      this.boxes[this.selected] = { ...quadBox(corners), confidence: 1, method: 'manual-corners', fallback: false };
    } else {
      const x = Math.min(this.drag.start.x, point.x);
      const y = Math.min(this.drag.start.y, point.y);
      const width = Math.max(min, Math.abs(point.x - this.drag.start.x));
      const height = Math.max(min, Math.abs(point.y - this.drag.start.y));
      this.boxes[this.selected] = {
        x, y, width, height,
        corners: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }],
        confidence: 1, method: 'manual-box', fallback: false
      };
    }
    this.render();
  }

  onPointerUp(event) {
    if (!this.drag) return;
    event.preventDefault();
    this.drag = null;
    if (this.mode === 'add') this.mode = 'select';
    this.boxes = this.boxes.map((box) => ({
      ...box,
      x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
      corners: box.corners?.map((corner) => ({ x: Math.round(corner.x), y: Math.round(corner.y) }))
    }));
    this.onChange(this.boxes);
    this.render();
  }

  setAddMode() {
    if (this.single) return;
    this.mode = 'add';
    this.render();
  }

  deleteSelected() {
    if (this.single) return;
    if (this.selected < 0) return;
    this.boxes.splice(this.selected, 1);
    this.selected = Math.min(this.boxes.length - 1, this.selected);
    this.onChange(this.boxes);
    this.render();
  }

  applyGrid(rows, columns) {
    if (this.single) return;
    this.boxes = gridBoxes(this.canvas.width, this.canvas.height, rows, columns).map((box) => ({
      ...box,
      corners: [
        { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
      ],
      confidence: 1, method: 'manual-grid', fallback: false
    }));
    this.selected = 0;
    this.onChange(this.boxes);
    this.render();
  }

  async detectWithWorker(imageData, maximumCards) {
    if (typeof Worker !== 'function') return null;
    const job = ++this.detectionJob;
    const worker = new Worker(new URL('./scan-detection-worker.js', import.meta.url), { type: 'module' });
    this.detectionWorker?.terminate();
    this.detectionWorker = worker;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.terminate();
        if (this.detectionWorker === worker) this.detectionWorker = null;
        if (job !== this.detectionJob || this.destroyed) return resolve(null);
        callback(value);
      };
      const timeout = setTimeout(() => finish(reject, new Error('Boundary detection took too long.')), 20_000);
      worker.addEventListener('message', (event) => {
        if (event.data?.error) finish(reject, new Error(event.data.error));
        else finish(resolve, event.data?.boxes || []);
      }, { once: true });
      worker.addEventListener('error', () => finish(reject, new Error('Boundary worker could not start.')), { once: true });
      worker.postMessage({
        id: job,
        buffer: imageData.data.buffer,
        width: imageData.width,
        height: imageData.height,
        maximumCards
      }, [imageData.data.buffer]);
    });
  }

  async detect() {
    if (this.destroyed) return this.boxes;
    const max = 1000;
    const scale = Math.min(1, max / Math.max(this.canvas.width, this.canvas.height));
    const analysis = document.createElement('canvas');
    analysis.width = Math.max(1, Math.round(this.canvas.width * scale));
    analysis.height = Math.max(1, Math.round(this.canvas.height * scale));
    const context = analysis.getContext('2d', { willReadFrequently: true });
    context.drawImage(this.image, 0, 0, analysis.width, analysis.height);
    this.onStatus('detecting');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const maximumCards = this.single ? 1 : 24;
    const pixels = context.getImageData(0, 0, analysis.width, analysis.height);
    let detected;
    try {
      detected = await this.detectWithWorker(pixels, maximumCards);
    } catch {
      // A worker is preferred, but a yielded main-thread fallback keeps scan
      // available in browsers that block module workers or transferable pixels.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const fallbackContext = analysis.getContext('2d', { willReadFrequently: true });
      fallbackContext.drawImage(this.image, 0, 0, analysis.width, analysis.height);
      detected = detectBoundaries(fallbackContext.getImageData(0, 0, analysis.width, analysis.height), { maximumCards });
    }
    if (detected === null || this.destroyed) return this.boxes;
    detected = detected.map((box) => mapBox(box, 1 / scale, 1 / scale));
    this.boxes = this.single ? [detected[0] || this.manualFallback()] : detected;
    this.selected = 0;
    this.onChange(this.boxes);
    this.render();
    this.onStatus('complete');
    return this.boxes;
  }

  render() {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(this.image, 0, 0, this.canvas.width, this.canvas.height);
    const line = Math.max(3, Math.min(this.canvas.width, this.canvas.height) * 0.006);
    this.boxes.forEach((box, index) => {
      this.context.fillStyle = index === this.selected ? 'rgba(130,232,173,.12)' : 'rgba(120,185,255,.08)';
      this.context.strokeStyle = index === this.selected ? '#82e8ad' : '#78b9ff';
      this.context.lineWidth = line;
      const corners = box.corners || [
        { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
      ];
      this.context.beginPath();
      this.context.moveTo(corners[0].x, corners[0].y);
      corners.slice(1).forEach((corner) => this.context.lineTo(corner.x, corner.y));
      this.context.closePath();
      this.context.fill();
      this.context.stroke();
      this.context.fillStyle = this.context.strokeStyle;
      this.context.font = `${line * 4}px system-ui`;
      this.context.fillText(String(index + 1), box.x + line * 2, box.y + line * 5);
      if (index === this.selected) corners.forEach((corner) => this.context.fillRect(corner.x - line * 3, corner.y - line * 3, line * 6, line * 6));
    });
    if (this.mode === 'add') {
      this.context.fillStyle = 'rgba(9,16,24,.75)';
      this.context.fillRect(0, 0, this.canvas.width, Math.max(38, line * 8));
      this.context.fillStyle = '#82e8ad';
      this.context.font = `${Math.max(18, line * 4)}px system-ui`;
      this.context.fillText('Draw a new boundary', line * 2, Math.max(27, line * 5.5));
    }
  }
}
