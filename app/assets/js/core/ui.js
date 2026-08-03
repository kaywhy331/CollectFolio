import { clamp, escapeHTML, formatCurrency } from './utils.js';

let closeCurrent = null;

export function showToast(message, tone = 'success', duration = 3600) {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.innerHTML = `<span aria-hidden="true">${tone === 'error' ? '!' : '✓'}</span><span>${escapeHTML(message)}</span>`;
  region.append(toast);
  setTimeout(() => toast.remove(), duration);
}

export function openModal({ title, content, actions = '', onOpen } = {}) {
  closeCurrent?.();
  const root = document.querySelector('#modal-root');
  const lastFocus = document.activeElement;
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-layer';
  wrapper.innerHTML = `<div class="modal-backdrop" data-close-modal></div>
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header><h2 id="modal-title">${escapeHTML(title || '')}</h2><button class="icon-button" data-close-modal aria-label="Close">×</button></header>
      <div class="modal-content">${content || ''}</div>
      ${actions ? `<footer class="modal-actions">${actions}</footer>` : ''}
    </section>`;
  root.append(wrapper);
  const close = () => {
    wrapper.remove();
    closeCurrent = null;
    lastFocus?.focus?.();
  };
  closeCurrent = close;
  wrapper.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) close();
  });
  wrapper.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  wrapper.querySelector('input,select,textarea,button')?.focus();
  onOpen?.(wrapper, close);
  return close;
}

export function closeModal() {
  closeCurrent?.();
}

export function trendChart(snapshots = [], currency = 'USD') {
  const points = snapshots.slice(-90);
  if (!points.length) return '<div class="empty-chart">A trend appears after your first holding is added.</div>';
  const width = 720;
  const height = 260;
  const pad = 24;
  const values = points.flatMap((point) => [Number(point.marketValue) || 0, Number(point.costBasis) || 0]);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const coords = (field) => points.map((point, index) => {
    const x = pad + (index * (width - pad * 2)) / Math.max(points.length - 1, 1);
    const y = height - pad - (((Number(point[field]) || 0) - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const latest = points.at(-1);
  return `<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Market value and cost basis over ${points.length} days">
    <title>Market ${escapeHTML(formatCurrency(latest.marketValue, currency))}; cost ${escapeHTML(formatCurrency(latest.costBasis, currency))}</title>
    <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="chart-grid"/>
    <polyline points="${coords('marketValue')}" class="chart-line chart-market"/>
    <polyline points="${coords('costBasis')}" class="chart-line chart-cost"/>
  </svg><div class="chart-legend"><span><i class="market-dot"></i>Market value</span><span><i class="cost-dot"></i>Cost basis</span></div>`;
}

export function allocationChart(allocation = {}) {
  const entries = Object.entries(allocation).filter(([, value]) => value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return '<p class="muted">Add a valued holding to see allocation.</p>';
  let offset = 0;
  const colors = ['#82e8ad', '#78b9ff', '#ffca6d', '#c997ff', '#ff8297', '#72ded5'];
  const segments = entries.map(([label, value], index) => {
    const percent = value / total;
    const start = offset;
    offset += percent;
    return `<circle r="54" cx="64" cy="64" pathLength="1" stroke="${colors[index % colors.length]}" stroke-dasharray="${percent} ${1 - percent}" stroke-dashoffset="${-start}"/>`;
  }).join('');
  const legend = entries.map(([label, value], index) => `<li><i style="--swatch:${colors[index % colors.length]}"></i><span>${escapeHTML(label)}</span><strong>${clamp((value / total) * 100, 0, 100).toFixed(0)}%</strong></li>`).join('');
  return `<div class="allocation"><svg viewBox="0 0 128 128" role="img" aria-label="Portfolio allocation">${segments}</svg><ul>${legend}</ul></div>`;
}
