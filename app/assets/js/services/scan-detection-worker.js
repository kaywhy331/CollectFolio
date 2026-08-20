import { detectBoundaries } from './image-algorithms.js';

self.addEventListener('message', (event) => {
  const { id, buffer, width, height, maximumCards } = event.data || {};
  try {
    const pixels = new Uint8ClampedArray(buffer);
    const image = new ImageData(pixels, width, height);
    const boxes = detectBoundaries(image, { maximumCards });
    self.postMessage({ id, boxes });
  } catch (error) {
    self.postMessage({ id, error: error?.message || 'Boundary detection failed.' });
  }
});
