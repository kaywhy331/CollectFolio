import { escapeHTML } from './utils.js';

// DCL-LEX-11: the single, canonical home for every data-integrity guarantee
// (PRD Appendix B). Every guarantee below used to be repeated as prose
// across Item Detail, Collection, Insights, and Scenario surfaces; this is
// now the only place any of it renders. Views should link to or embed this
// component rather than restating any of these sentences themselves.
const METHODOLOGY_GUARANTEES = Object.freeze([
  'Values render only from verified market data, your manual entries, or clearly labeled estimates — never fabricated.',
  'Charts and ranges appear only when their supporting evidence exists.',
  'Scenarios come from your assumptions; forecasts come from validated models; the two are never mixed.',
  'A published forecast is never rewritten; matured predictions are scored as-is.',
  'Manual values stay distinct from market observations and never create cross-source returns.',
  'Amounts in other currencies are shown separately; no exchange rate is applied.',
  'Set completion is shown only when an authoritative catalog total is linked.',
  'Opportunity rankings require your purchase costs, fees, and liquidity evidence before they appear.'
]);

export function methodologyDisclosure() {
  const items = METHODOLOGY_GUARANTEES.map((guarantee) => `<li>${escapeHTML(guarantee)}</li>`).join('');
  return `<details class="data-details methodology-disclosure"><summary><span>How CollectFolio handles data</span><span>Guarantees behind every value, chart, and forecast</span></summary><div><ul class="evidence-list">${items}</ul></div></details>`;
}
