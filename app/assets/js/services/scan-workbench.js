import { clamp } from '../core/utils.js';
import { detectBoundaries, gridBoxes, mapBox } from './image-algorithms.js';

export class ScanWorkbench {
  constructor(canvas, image, { single = false, onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { willReadFrequently: true });
    this.image = image;
    this.onChange = onChange;
    this.single = single;
    this.boxes = [{ x: 0, y: 0, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height }];
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
    const size = Math.max(18, Math.min(this.canvas.width, this.canvas.height) * 0.025);
    return Math.abs(point.x - (box.x + box.width)) <= size && Math.abs(point.y - (box.y + box.height)) <= size;
  }

  onPointerDown(event) {
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.point(event);
    if (this.mode === 'add') {
      this.boxes.push({ x: point.x, y: point.y, width: 1, height: 1 });
      this.selected = this.boxes.length - 1;
      this.drag = { type: 'draw', start: point };
      this.render();
      return;
    }
    const selectedBox = this.boxes[this.selected];
    if (selectedBox && this.isHandle(point, selectedBox)) {
      this.drag = { type: 'resize', start: point, box: { ...selectedBox } };
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
      this.boxes[this.selected] = { ...this.drag.box, x: clamp(this.drag.box.x + dx, 0, this.canvas.width - this.drag.box.width), y: clamp(this.drag.box.y + dy, 0, this.canvas.height - this.drag.box.height) };
    } else if (this.drag.type === 'resize') {
      this.boxes[this.selected] = { ...this.drag.box, width: clamp(this.drag.box.width + point.x - this.drag.start.x, min, this.canvas.width - this.drag.box.x), height: clamp(this.drag.box.height + point.y - this.drag.start.y, min, this.canvas.height - this.drag.box.y) };
    } else {
      this.boxes[this.selected] = { x: Math.min(this.drag.start.x, point.x), y: Math.min(this.drag.start.y, point.y), width: Math.max(min, Math.abs(point.x - this.drag.start.x)), height: Math.max(min, Math.abs(point.y - this.drag.start.y)) };
    }
    this.render();
  }

  onPointerUp(event) {
    if (!this.drag) return;
    event.preventDefault();
    this.drag = null;
    if (this.mode === 'add') this.mode = 'select';
    this.boxes = this.boxes.map((box) => ({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }));
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
    this.boxes = gridBoxes(this.canvas.width, this.canvas.height, rows, columns);
    this.selected = 0;
    this.onChange(this.boxes);
    this.render();
  }

  detect() {
    if (this.single) {
      this.boxes = [{ x: 0, y: 0, width: this.canvas.width, height: this.canvas.height }];
    } else {
      const max = 1000;
      const scale = Math.min(1, max / Math.max(this.canvas.width, this.canvas.height));
      const analysis = document.createElement('canvas');
      analysis.width = Math.max(1, Math.round(this.canvas.width * scale));
      analysis.height = Math.max(1, Math.round(this.canvas.height * scale));
      const context = analysis.getContext('2d', { willReadFrequently: true });
      context.drawImage(this.image, 0, 0, analysis.width, analysis.height);
      this.boxes = detectBoundaries(context.getImageData(0, 0, analysis.width, analysis.height)).map((box) => mapBox(box, 1 / scale, 1 / scale));
    }
    this.selected = 0;
    this.onChange(this.boxes);
    this.render();
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
      this.context.fillRect(box.x, box.y, box.width, box.height);
      this.context.strokeRect(box.x, box.y, box.width, box.height);
      this.context.fillStyle = this.context.strokeStyle;
      this.context.font = `${line * 4}px system-ui`;
      this.context.fillText(String(index + 1), box.x + line * 2, box.y + line * 5);
      if (index === this.selected) this.context.fillRect(box.x + box.width - line * 3, box.y + box.height - line * 3, line * 6, line * 6);
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
