// Pointer tooltips for the inline-SVG price chart (Kevin 2026-08-18:
// hovering the line at any x-position must surface the date it represents
// and the price as a popup).
//
// The chart markup is a plain HTML string re-rendered on every state
// change, so nothing is wired per-render: historyLineChart embeds its
// plotted points as a `data-chart-points` JSON attribute on the <svg>,
// and one delegated pointer listener on a stable ancestor does the rest.
// Dependency-free, presentation-only -- prices shown are exactly the
// plotted values, never recomputed.

const payloadCache = new WeakMap();

function chartPoints(svg) {
  if (payloadCache.has(svg)) return payloadCache.get(svg);
  let points = [];
  try {
    const parsed = JSON.parse(svg.getAttribute('data-chart-points') || '[]');
    points = Array.isArray(parsed)
      ? parsed.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y) && typeof point?.l === 'string')
      : [];
  } catch { /* malformed payload -> no tooltip, never an error */ }
  payloadCache.set(svg, points);
  return points;
}

function ensureTooltip(wrap) {
  let tip = wrap.querySelector('.chart-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    tip.setAttribute('aria-hidden', 'true');
    tip.hidden = true;
    wrap.appendChild(tip);
  }
  return tip;
}

function hideTooltip(wrap) {
  const tip = wrap.querySelector('.chart-tooltip');
  if (tip) tip.hidden = true;
  const marker = wrap.querySelector('.chart-tooltip-marker');
  if (marker) marker.hidden = true;
}

function ensureMarker(wrap) {
  let marker = wrap.querySelector('.chart-tooltip-marker');
  if (!marker) {
    marker = document.createElement('div');
    marker.className = 'chart-tooltip-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.hidden = true;
    wrap.appendChild(marker);
  }
  return marker;
}

function viewBoxSize(svg) {
  const parts = String(svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  return parts.length === 4 && parts[2] > 0 && parts[3] > 0 ? { width: parts[2], height: parts[3] } : null;
}

function showTooltip(svg, event) {
  const points = chartPoints(svg);
  const box = viewBoxSize(svg);
  const wrap = svg.closest('.chart-wrap');
  if (!points.length || !box || !wrap) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pointerX = ((event.clientX - rect.left) / rect.width) * box.width;
  let nearest = points[0];
  for (const point of points) {
    if (Math.abs(point.x - pointerX) < Math.abs(nearest.x - pointerX)) nearest = point;
  }
  const wrapRect = wrap.getBoundingClientRect();
  const px = (rect.left - wrapRect.left) + ((nearest.x / box.width) * rect.width);
  const py = (rect.top - wrapRect.top) + ((nearest.y / box.height) * rect.height);
  const tip = ensureTooltip(wrap);
  tip.textContent = nearest.l;
  tip.hidden = false;
  const clampedX = Math.min(Math.max(px, 56), wrapRect.width - 56);
  tip.style.left = `${clampedX}px`;
  tip.style.top = `${Math.max(py - 12, 4)}px`;
  const marker = ensureMarker(wrap);
  marker.hidden = false;
  marker.style.left = `${px}px`;
  marker.style.top = `${py}px`;
}

// One-time delegation on a stable ancestor (survives every re-render).
export function attachChartHover(rootElement) {
  if (!rootElement || rootElement.dataset.chartHoverAttached === 'true') return;
  rootElement.dataset.chartHoverAttached = 'true';
  rootElement.addEventListener('pointermove', (event) => {
    const svg = event.target.closest?.('svg[data-chart-points]');
    if (svg) {
      showTooltip(svg, event);
    } else {
      const wrap = event.target.closest?.('.chart-wrap');
      if (!wrap) rootElement.querySelectorAll('.chart-tooltip:not([hidden])').forEach((tip) => hideTooltip(tip.parentElement));
    }
  }, { passive: true });
  rootElement.addEventListener('pointerdown', (event) => {
    const svg = event.target.closest?.('svg[data-chart-points]');
    if (svg) showTooltip(svg, event);
  }, { passive: true });
  rootElement.addEventListener('pointerout', (event) => {
    const wrap = event.target.closest?.('.chart-wrap');
    if (wrap && !wrap.contains(event.relatedTarget)) hideTooltip(wrap);
  }, { passive: true });
}
