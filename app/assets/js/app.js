import { pageHeader } from './core/components.js';
import { getState, setState, subscribe } from './core/store.js';
import { escapeHTML } from './core/utils.js';

const root = document.querySelector('#main-content');

const shellViews = {
  home: ['Portfolio overview', 'Your collection is ready.', 'Track value without confusing purchases with market movement.'],
  search: ['Catalog discovery', 'Search collectibles', 'Search Pokémon, Magic, and Yu-Gi-Oh! catalogs together.'],
  add: ['Collection intake', 'Add collectibles', 'Scan multiple items, upload one image, search manually, or create a custom holding.'],
  portfolio: ['Collection analytics', 'Portfolio', 'Filter, sort, edit, and export holdings stored on this device.'],
  profile: ['Settings and portability', 'Profile', 'Your portfolio belongs to you—online or offline.']
};

function render(state = getState()) {
  const [eyebrow, title, description] = shellViews[state.activeView] || shellViews.home;
  root.innerHTML = `${pageHeader(eyebrow, title, description)}
    <section class="card welcome-card">
      <p class="eyebrow">Local-first by design</p>
      <h2>${escapeHTML(state.activeView === 'add' ? 'Choose an intake path' : 'CollectFolio MVP')}</h2>
      <p>Everything begins on this device. Cloud sync is optional, source photos stay local, and no holding is added without your approval.</p>
    </section>`;
  document.querySelectorAll('[data-view]').forEach((button) => {
    const selected = button.dataset.view === state.activeView;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
}

document.querySelector('.bottom-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  setState({ activeView: button.dataset.view });
  root.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

subscribe(render);
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
