import { pageHeader } from '../core/components.js';
import { escapeHTML } from '../core/utils.js';

const progress = (active) => `<ol class="onboarding-progress" aria-label="Setup progress">${[
  ['welcome', 'Storage'], ['currency', 'Currency'], ['add', 'First item']
].map(([step, label], index) => `<li class="${step === active ? 'active' : ''}" ${step === active ? 'aria-current="step"' : ''}><span>${index + 1}</span>${label}</li>`).join('')}</ol>`;

export function renderOnboarding(state) {
  const step = ['welcome', 'currency', 'add'].includes(state.settings.onboardingStep)
    ? state.settings.onboardingStep
    : 'welcome';
  const cloudAvailable = Boolean(globalThis.window?.COLLECTFOLIO_CONFIG?.SUPABASE_URL
    && globalThis.window?.COLLECTFOLIO_CONFIG?.SUPABASE_ANON_KEY);
  const common = `${pageHeader('Setup', 'Set up CollectFolio', 'Start locally in under a minute. An account is always optional.')}${progress(step)}`;
  if (step === 'currency') {
    return `<section class="onboarding-shell">${common}<div class="card onboarding-card"><p class="eyebrow">Currency</p><h2>Choose your collection currency</h2><p>Totals include only values recorded in this currency. Amounts in other currencies stay labeled and separate; CollectFolio never guesses an exchange rate.</p><form id="onboarding-currency"><label>Display currency<select name="currency">${[
      ['USD', 'USD — US Dollar'], ['CAD', 'CAD — Canadian Dollar'], ['EUR', 'EUR — Euro'], ['GBP', 'GBP — Pound sterling']
    ].map(([value, label]) => `<option value="${value}" ${state.settings.currency === value ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('')}</select></label><div class="button-row"><button class="button ghost" type="button" data-action="onboarding-back">Back</button><button class="button" type="submit">Save and continue</button></div></form></div><button class="onboarding-skip" type="button" data-action="skip-onboarding">Skip setup and use recommended defaults</button></section>`;
  }
  if (step === 'add') {
    const cloud = state.settings.onboardingStorage === 'cloud';
    const cloudConnect = cloud && !state.auth.session
      ? `<button class="button secondary" type="button" data-action="open-auth" ${cloudAvailable ? '' : 'disabled aria-describedby="cloud-unavailable"'}>Connect cloud backup</button>${cloudAvailable ? '' : "<small id=\"cloud-unavailable\" class=\"fine-print\">Cloud backup isn't available yet. You can continue with storage on this device.</small>"}`
      : '';
    return `<section class="onboarding-shell">${common}<div class="card onboarding-card"><p class="eyebrow">First item</p><h2>Add your first collectible</h2><p>Search a catalog, scan an image, import a backup, or create a custom item. Pricing is optional, and unsupported items remain visible.</p><div class="onboarding-choice-summary"><span>Saved ${cloud ? 'with optional cloud backup' : 'on this device'}</span><span>${escapeHTML(state.settings.currency)} collection currency</span></div><div class="button-row"><button class="button ghost" type="button" data-action="onboarding-back">Back</button><button class="button" type="button" data-action="onboarding-add">Choose how to add</button>${cloudConnect}</div></div><button class="onboarding-skip" type="button" data-action="skip-onboarding">Finish setup without adding now</button></section>`;
  }
  return `<section class="onboarding-shell">${common}<div class="card onboarding-card"><p class="eyebrow">Storage</p><h2>Where should your collection start?</h2><p>Local storage is private to this browser and works offline. Cloud backup is optional and can synchronize purchases across signed-in devices.</p><div class="onboarding-options"><button type="button" data-action="onboarding-storage" data-storage="local"><strong>Save on this device</strong><span>No account. Works offline. Export a backup whenever you like.</span></button><button type="button" data-action="onboarding-storage" data-storage="cloud"><strong>Use cloud backup</strong><span>Start locally now, then connect an optional account for cross-device sync.</span></button></div></div><button class="onboarding-skip" type="button" data-action="skip-onboarding">Skip setup and use recommended defaults</button></section>`;
}
