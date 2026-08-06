# CollectFolio Price Intelligence, Watchlist, and Forecasting
## Product Requirements Document + Technical/Data Specification

**Document version:** 1.1  
**Prepared:** August 2026  
**Repository:** `kaywhy331/CollectFolio`  
**Deployment target:** Static Netlify PWA + Supabase Free + GitHub Actions  
**Feature status:** Foundation implemented; licensed production source pending activation  
**Primary initial market:** English, raw Pokémon TCG singles  

---

## 1. Executive decision

CollectFolio should add a **Price Intelligence** system with four deliberately separate outputs:

1. **Observed market value** — the latest permitted market-data observation.
2. **Trend analysis** — what the price has recently done.
3. **Structural fair-value range** — what comparable cards with similar scarcity and demand characteristics usually trade around.
4. **Probabilistic forecast** — the modeled distribution of possible prices at 7, 30, 90, 180, and 365 days.

These outputs must never be collapsed into one opaque “AI price.” Explaining today’s price, measuring recent movement, and forecasting a future return are different statistical tasks.

The video model is retained as **`video_model_v0`**, an educational benchmark that combines pull scarcity and desirability. It must not be promoted as the production forecasting model because its source workbook, point-in-time feature data, scoring rubric, and out-of-sample validation are unavailable.

### Critical data-rights conclusion

A comprehensive, **free**, legally unambiguous historical market-price feed for every Pokémon card was not identified. A practical paid route now exists: JustTCG's July 27, 2026 terms expressly license paid subscribers to display current prices and historical trends to end users, build derived analytics and aggregate valuations, and retain app-bound price points while subscribed. Its API exposes condition/printing-specific prices and a trailing one-year daily history. TCGCSV remains technically valuable for internal research and historical backtesting, but it republishes TCGplayer-derived content, and TCGplayer’s API terms restrict third-party collection, redistribution, rebranding, derivative use, and competitive products without approval.

The preferred production source is therefore **JustTCG on a paid plan**, beginning with the $19/month Starter tier. This is an engineering selection, not an activated source approval: CollectFolio must first subscribe, archive the accepted terms, record a current immutable approved review, store the API key server-side, and complete exact mapping and database gates. The free JustTCG tier is personal/non-commercial and cannot power CollectFolio.

Therefore, the feature must support two operating modes:

| Mode | Purpose | Data visibility |
|---|---|---|
| **Research mode** | Internal model development, mapping, and walk-forward evaluation | Restricted to Kevin/operators; no public redistribution of unapproved source data or derived outputs |
| **Production mode** | User-facing watchlist, trends, fair-value ranges, and forecasts | Only sources and derived outputs explicitly marked as permitted for public display |

The product and architecture can be built now. Public price intelligence must remain source-gated until the paid license and data rights are documented in the live source registry.

---

## 2. Existing-product context

CollectFolio is already a dependency-free, local-first PWA. The current application uses:

- Static Netlify deployment.
- Browser-native ES modules.
- IndexedDB as the primary user datastore.
- Optional Supabase Auth and PostgREST synchronization.
- Free catalog adapters.
- A five-action mobile shell: Home, Search, Add, Portfolio, Profile.
- Local image processing and OCR-assisted matching.

This feature must extend—not replace—that architecture.

### Architectural boundary

The browser remains responsible for:

- Watchlist interaction.
- Chart rendering.
- Cached user-facing data.
- Local portfolio calculations.
- Local notification state.

GitHub Actions and Supabase become the analytics plane responsible for:

- Scheduled source ingestion.
- Card/source mapping.
- Point-in-time feature generation.
- Model training and evaluation.
- Forecast publishing.
- Immutable prediction and outcome records.

No paid inference endpoint, Netlify Function, or always-on application server is required.

---

## 3. Problem statement

Collectors can see current values in many tools, but they usually cannot answer these questions transparently:

- Is the card actually trending, or did one stale/provider-specific price move?
- Is the current price unusual relative to structurally similar cards?
- What range of outcomes is plausible over 30 days, six months, or one year?
- What information drove the estimate?
- Has this model historically been correct on similar cards?
- Is the underlying data fresh, liquid, and legally displayable?

The original video attempts to explain top chase-card prices using:

- Supply through specific-card pull difficulty and pack cost.
- Demand through character premium, artwork/hype, and broad appeal.

That framing is useful, but CollectFolio needs a reproducible, point-in-time, uncertainty-aware, and auditable implementation.

---

## 4. Product vision

> Give collectors an honest view of where a card has been, what structurally supports its price, what may happen next, and how reliable the evidence is.

### User promise

CollectFolio will not claim certainty. It will show:

- The observed price and source.
- The recent trend and volatility.
- A structural fair-value range.
- A probabilistic forecast range.
- Confidence and data-quality indicators.
- The model’s past performance at the selected horizon.

---

## 5. Goals

### Product goals

1. Let users create and manage a Pokémon card watchlist without adding cards to holdings.
2. Display trustworthy 7/30/90/180/365-day price trends for supported cards.
3. Produce structural fair-value ranges for sufficiently supported card cohorts.
4. Produce probabilistic forecasts at 7, 30, 90, 180, and 365 days.
5. Maintain an immutable prediction ledger and automatically evaluate matured forecasts.
6. Explain the strongest forecast drivers in collector-friendly language.
7. Preserve source, timestamp, terms, mapping, feature, and model provenance.
8. Operate within free Netlify, Supabase, and public-repository GitHub Actions quotas during the pilot.
9. Support all cataloged Pokémon cards structurally while displaying only the intelligence level supported by available evidence.

### Research goals

1. Test whether pull scarcity adds predictive value beyond current price and momentum.
2. Test whether character premium predicts future excess returns or merely explains current cross-sectional prices.
3. Test whether artwork preference and CollectFolio demand velocity improve forecasts.
4. Compare all complex models against simple baselines.
5. Measure performance by horizon, lifecycle, price tier, set, rarity, and market regime.

---

## 6. Non-goals

The first production version will not:

- Guarantee future prices.
- Issue buy, sell, or investment advice.
- Present an in-sample R² value as forecast accuracy.
- Predict condition or grading outcomes.
- Forecast graded cards and raw cards with one shared model.
- Treat active listing asks as completed-sale market value.
- Assume pull-rate data exists for every historical set or promo.
- Use PriceCharting data without written permission.
- Expose TCGplayer-derived data or derivatives publicly without an approved rights basis.
- Train on future data or overwrite prior predictions after outcomes become known.
- Upload original user card photos for model training without explicit opt-in.
- Add a sixth persistent bottom-navigation item.

---

## 7. Target users and jobs

### 7.1 Watchlist collector

**Context:** Follows cards they may eventually acquire.  
**Job:** Understand direction, reasonable ranges, and risk without checking several sites daily.

### 7.2 Portfolio owner

**Context:** Already owns cards in CollectFolio.  
**Job:** Detect material changes, concentration risk, and holdings whose trend or modeled range changed.

### 7.3 Data-curious collector

**Context:** Wants to understand why one chase card trades above another.  
**Job:** Explore scarcity, character, artwork, lifecycle, and market factors.

### 7.4 Operator/model administrator

**Context:** Maintains sources, mappings, pull rates, models, and data-quality policies.  
**Job:** Reproduce every output, investigate anomalies, and prevent unapproved data from appearing publicly.

---

## 8. Product principles

1. **Evidence before prediction.** No forecast without sufficient, point-in-time data.
2. **Ranges before point claims.** Median estimates are always paired with intervals.
3. **Separation of concerns.** Observed price, trend, fair value, and forecast remain distinct.
4. **Source transparency.** Every value carries provider, subtype, freshness, and rights status.
5. **Auditability.** Every prediction retains its feature cutoff, dataset hash, code/model version, and output quantiles.
6. **No silent leakage.** Future outcomes, target-card prices, and post-cutoff events cannot enter historical features.
7. **Baseline honesty.** A complex model ships only when it beats a no-change or simple momentum baseline out of sample.
8. **Progressive coverage.** Unsupported cards display a lower intelligence tier instead of fabricated estimates.
9. **Local-first continuity.** Watchlists and last-known outputs remain usable offline.
10. **Reversible deployment.** The feature is gated by source and model flags and can be disabled without damaging holdings.

---

## 9. Terminology contract

| Term | Product meaning |
|---|---|
| **Observed price** | A source-attributed market observation for an exact card variant/finish/condition class |
| **Trend** | Historical movement derived from observed prices; not a future prediction |
| **Structural fair value** | A modeled range based on scarcity, demand, lifecycle, and comparable-card structure |
| **Forecast** | A horizon-specific probability distribution for future return/price |
| **Prediction origin** | Timestamp at which a forecast was generated |
| **Feature cutoff** | Latest timestamp any input was allowed to use |
| **Maturity date** | Date when a forecast horizon can be evaluated |
| **Confidence** | Evidence-quality score, not probability that the point forecast is exactly correct |
| **Coverage** | Percentage of realized outcomes contained inside an advertised interval |
| **Model 0** | Forensic reconstruction of the video’s current-price model |
| **Champion model** | Current production model for a horizon/cohort |
| **Challenger model** | Candidate model evaluated invisibly against the champion |

---

## 10. Information architecture

The five existing bottom-navigation items remain unchanged.

### 10.1 Portfolio tab

Add a segmented control:

```text
[ Holdings ] [ Watchlist ] [ Forecasts ]
```

- **Holdings:** Existing collection list and analytics.
- **Watchlist:** Cards the user follows but may not own.
- **Forecasts:** Prediction history, model scorecards, and cards with material signal changes.

### 10.2 Search and card detail

Every supported Pokémon result adds:

- **Add to Portfolio**
- **Watch** / **Watching**
- **Price Intelligence** preview when supported

### 10.3 Home

Add two compact modules:

- **Portfolio Movers:** largest supported holding changes.
- **Watchlist Signals:** cards whose trend, fair-value position, or forecast changed materially.

### 10.4 Profile

Add **Data & Model** settings:

- Data-source status.
- Last market refresh.
- Last model run.
- Forecast availability.
- Research/production mode badge.
- Source attributions.
- Model methodology.
- Prediction performance.
- Privacy and demand-signal settings.

---

## 11. Core user journeys

### 11.1 Add a card to the watchlist

1. User searches or scans a card.
2. User selects the exact card and finish.
3. User taps **Watch**.
4. User may optionally set:
   - Target price.
   - Percentage-change alert.
   - Trend-change alert.
   - Fair-value-position alert.
   - Forecast-change alert.
5. The card appears in Watchlist immediately using local IndexedDB.
6. Signed-in users sync the watchlist to Supabase.

### 11.2 Review price intelligence

1. User opens a watched or owned card.
2. The page displays:
   - Current observed value.
   - Source and freshness.
   - Price chart.
   - Trend classification.
   - Structural fair-value band.
   - Horizon selector.
   - Forecast median and intervals.
   - Probability of positive return.
   - Confidence.
3. User opens **Why this estimate?**
4. The app explains top positive/negative drivers, missing data, and model limitations.

### 11.3 Review past predictions

1. User selects **Prediction history**.
2. The app shows each immutable forecast by origin and horizon.
3. Matured records show:
   - Forecast range.
   - Realized evaluation price.
   - Whether the interval contained the result.
   - Direction correctness.
   - Error.
4. Open forecasts show maturity date and remain unchanged.

### 11.4 Compare cards

1. User selects up to four cards.
2. Compare:
   - Current price.
   - 30/90/365-day return.
   - Volatility.
   - Structural value position.
   - Forecast probability of gain.
   - Data confidence.
3. Comparison must not rank a low-confidence estimate above a high-confidence estimate without visibly showing the difference.

### 11.5 Unsupported card

1. User opens an unsupported card.
2. The app shows available identity and price data.
3. Missing sections explain why:
   - Insufficient history.
   - Unresolved source mapping.
   - No permitted public data.
   - Unsupported graded/condition class.
   - No valid model cohort.
4. User can still watch the card and provide a manual value.

---

## 12. Intelligence coverage contract

Every card receives one explicit support tier.

| Tier | Name | Available output |
|---|---|---|
| 0 | **Identity only** | Catalog identity and user notes |
| 1 | **Price only** | Latest permitted observed value |
| 2 | **Trend supported** | Price plus historical trend/volatility |
| 3 | **Fair value supported** | Trend plus structural fair-value range |
| 4 | **Forecast supported** | Fair value plus one or more horizon forecasts |
| 5 | **Fully evaluated** | Forecast plus matured prediction history and cohort scorecard |

### Initial production cohort

The first forecast-supported cohort should be:

- English cards.
- Raw/ungraded.
- Exact mapped variant and finish.
- Pokémon singles.
- Minimum history threshold satisfied.
- Minimum price-quality threshold satisfied.
- Model cohort supported.
- Source/derived output marked public-display permitted.

### Initial exclusions

- Graded cards.
- Autographs and altered cards.
- Error cards and misprints.
- Japanese and other languages until independently modeled.
- Cards with unresolved variants.
- Cards with sparse/stale/null prices.
- Promos or guaranteed-product cards when pull-scarcity semantics are not applicable.

---

## 13. Functional requirements

### 13.1 Watchlist

- **WAT-001:** Users can watch/unwatch a catalog card from Search, scan review, holding detail, or card detail.
- **WAT-002:** Watchlist state works locally without authentication.
- **WAT-003:** Signed-in users can sync watchlists through Supabase RLS.
- **WAT-004:** A watched card stores exact catalog variant, finish, language, and desired condition class.
- **WAT-005:** Users can set optional target and signal alerts.
- **WAT-006:** Watchlist supports text, set, rarity, character, support-tier, confidence, trend, and forecast filtering.
- **WAT-007:** Users can sort by value, recent change, forecast median, probability of gain, confidence, date watched, or alert status.
- **WAT-008:** Removing a watch item creates a sync-safe tombstone.

### 13.2 Observed market data

- **MKT-001:** Every automated price names its source, subtype, currency, observation time, and ingestion time.
- **MKT-002:** Exact variant/finish mapping is mandatory; ambiguous products remain unmapped.
- **MKT-003:** Manual price never destroys provider data.
- **MKT-004:** Active listing prices must be labeled as asking prices and excluded from the primary market-price series unless the model explicitly uses them as a separate feature.
- **MKT-005:** Price-source rights determine whether raw values and derivatives may be publicly displayed.
- **MKT-006:** Stale prices display age and do not silently participate in fresh forecasts.
- **MKT-007:** Extreme or impossible observations are quarantined, not deleted.

### 13.3 Trend analysis

- **TRD-001:** Calculate 7/30/90/180/365-day returns when endpoints exist.
- **TRD-002:** Calculate robust slope, volatility, acceleration, drawdown, and data completeness.
- **TRD-003:** Trend status is one of: Strong rise, Rise, Stable, Fall, Strong fall, Insufficient data.
- **TRD-004:** Trend confidence accounts for history density, staleness, and source quality.
- **TRD-005:** Charts distinguish observed, interpolated, and missing periods.
- **TRD-006:** User additions/removals from the portfolio never appear as market appreciation.

### 13.4 Structural fair value

- **FAV-001:** Fair value is a range, not a single authoritative appraisal.
- **FAV-002:** The model uses only features available at the estimate cutoff.
- **FAV-003:** Target-card outcomes are excluded from character/artwork features.
- **FAV-004:** Pull probability and sealed-price variables remain separate.
- **FAV-005:** Missing pull rates are represented explicitly, not imputed as average without disclosure.
- **FAV-006:** Fair-value position is: Below modeled range, Within modeled range, Above modeled range, or Insufficient evidence.
- **FAV-007:** The detail view exposes major drivers and limitations.

### 13.5 Forecasting

- **FCT-001:** Use direct models for 7, 30, 90, 180, and 365 days.
- **FCT-002:** Forecast the future log return, then transform to price.
- **FCT-003:** Return q10, q25, q50, q75, and q90 estimates.
- **FCT-004:** Display median, 50% interval, 80% interval, and probability of positive return.
- **FCT-005:** Each forecast stores origin, feature cutoff, model version, dataset hash, code hash, and source-policy status.
- **FCT-006:** An existing forecast is immutable.
- **FCT-007:** New models create new records; they never rewrite historical predictions.
- **FCT-008:** Unsupported or low-confidence cards display no forecast rather than a fabricated one.
- **FCT-009:** One-year forecasts use wider intervals and visibly lower confidence when evidence warrants it.
- **FCT-010:** User-facing copy avoids “guaranteed,” “will reach,” “buy,” and “sell.”

### 13.6 Prediction evaluation

- **EVA-001:** Every forecast receives a maturity date.
- **EVA-002:** A scheduled evaluator records the realized evaluation price after maturity.
- **EVA-003:** Realized price uses a declared rule, such as the trailing seven-day median ending at maturity.
- **EVA-004:** Outcomes with insufficient price data become Unscorable rather than Failed.
- **EVA-005:** Store absolute error, percentage error, log-return error, direction result, interval hits, and baseline results.
- **EVA-006:** Show scorecards by horizon and cohort.
- **EVA-007:** Public model claims must use held-out or prospective performance only.

### 13.7 Alerts

- **ALT-001:** V1 supports in-app alerts evaluated when current intelligence data is received.
- **ALT-002:** Alerts can trigger on target price, percent move, trend change, range position, confidence deterioration, or forecast shift.
- **ALT-003:** Duplicate alerts are suppressed using event keys and cooldown periods.
- **ALT-004:** Optional web push is a later enhancement and must not be required for the feature to work.

### 13.8 Operator controls

- **OPS-001:** Operators can review unresolved mappings.
- **OPS-002:** Operators can correct source-to-catalog mappings without changing internal IDs.
- **OPS-003:** Operators can quarantine a source, set, card, model, or model run.
- **OPS-004:** Operators can mark raw display and derived display permissions separately.
- **OPS-005:** Operators can publish a champion model only after acceptance gates pass.
- **OPS-006:** Every manual correction has actor, reason, previous value, and timestamp.

---

## 14. User-facing output specification

### 14.1 Watchlist list item

```text
Mega Charizard X ex #125
Phantasmal Flames · SIR · Raw

$802.00                  +18.2% / 30D
Trend: Strong rise       Confidence: Medium
Fair value: $510–$730    Above modeled range
1Y median: $845          80%: $540–$1,210
Updated 7h ago
```

### 14.2 Detail header

- Card image: user-owned photo first when available.
- Name, set, number, rarity, variant, finish, language.
- Watch state.
- Holding state and quantity.
- Current observed price.
- Price-source badge.
- Data freshness.
- Support tier.

### 14.3 Chart

Controls:

```text
[ Price ] [ Trend ] [ Fair Value ] [ Forecast ]
[ 30D ] [ 90D ] [ 180D ] [ 1Y ] [ All ]
```

Chart semantics:

- Solid line: observed price.
- Muted gap: missing data.
- Shaded band: structural range or forecast interval.
- Vertical marker: prediction origin.
- Event badges: release, restock/reprint, model change, mapping correction.

### 14.4 Forecast panel

```text
1-year outlook
Current observed price     $802
Median modeled outcome     $845
50% interval          $720–$990
80% interval        $540–$1,210
Probability of gain          58%
Confidence            Medium-low
```

### 14.5 Driver panel

Show at most five positive and five negative/uncertain drivers:

```text
Supporting factors
+ Strong character premium
+ Positive 90-day momentum
+ High artwork preference score

Limiting factors
- Current price above structural band
- Low pull-scarcity contribution
- Limited history in this lifecycle stage
```

Driver text must be generated from recorded feature contributions or declared rules—not invented by an LLM.

### 14.6 Model scorecard

```text
365-day model · Modern English raw
Matured forecasts: 842
Median absolute error: 18.4%
Direction accuracy: 61.2%
80% interval coverage: 77.9%
No-change baseline error: 22.7%
Last trained: 2026-07-01
```

---

## 15. Data-source strategy

### 15.1 Source policy framework

Every source is registered with capabilities and rights fields:

```text
catalog_metadata
images
current_price
historical_price
sealed_price
active_listings
completed_sales
pull_rates
public_raw_display_allowed
public_derived_display_allowed
commercial_use_allowed
attribution_required
reviewed_at
terms_url
```

No source enters production merely because it is technically accessible.

### 15.2 Data-source matrix

| Source | Intended use | Cost | Technical status | Production status | Critical caveat |
|---|---|---:|---|---|---|
| **CollectFolio user records** | Holdings, watchlists, purchase data, manual values | Free | Existing | Preferred | Private by default |
| **User-owned card photos** | Portfolio thumbnails and scan evidence | Free | Existing | Preferred | Never reuse for training without opt-in |
| **JustTCG paid API** | Condition/printing-specific current prices, one-year daily history, derived analytics | $19/month Starter | Bounded server adapter implemented | **Preferred pending paid activation review** | Free tier is non-commercial; no raw feed/export/API substitute; stored service use ends with the license |
| **Pokémon TCG API** | English catalog metadata, sets, images | Free tier | Existing metadata-only adapter | Catalog candidate pending IP/image review | Embedded TCGplayer/Cardmarket pricing is deliberately excluded; authenticated key cannot be exposed in browser |
| **pokemon-tcg-data GitHub** | Bulk English catalog seed | Free access | Candidate | Candidate pending rights review | Repository has raw data; do not assume all underlying imagery/IP is commercially licensed |
| **TCGdex** | Multilingual metadata fallback and catalog reconciliation | Free/MIT database project | Existing fallback | Candidate | Language completion differs; Pokémon IP still requires review |
| **TCGCSV** | Internal historical-price research and mapping | Free access | Strong research source | **Research only until written approval** | Data is TCGplayer-derived; TCGplayer API terms restrict third-party and competitive use |
| **TCGplayer pull-rate articles** | Curated modern-set pull-rate observations | Free reading | Candidate manual registry | Research/derived facts with provenance review | Sample estimates, confidence intervals, equal-population assumptions; not all sets covered |
| **Wikimedia Analytics API** | External character-interest proxy | Free/CC0 | Candidate | Good production candidate | Requires identifying User-Agent/Api-User-Agent; page identity mapping required |
| **Google Trends UI/API** | Optional broad-interest feature | Free UI / limited alpha API | Optional | Not a core dependency | API remains alpha/limited; UI values depend on geography, time window, comparison set, and normalization |
| **eBay Browse API** | Optional active-listing/image-discovery signal | Free developer program/default quota | Optional | Candidate with eBay approval/compliance | Active listings are asks, not completed-sale market value; Buy APIs may require production approval |
| **PriceCharting** | Potential licensed price provider | Paid | Excluded from free core | Not permitted without written agreement | Public app redistribution requires express written permission; API/CSV require subscription |
| **CollectFolio aggregate behavior** | Watch/search/portfolio velocity and artwork preference | Free first-party data | New | Preferred after privacy threshold | Must be aggregated, consented, abuse-resistant, and never expose individuals |

### 15.3 Catalog acquisition

Primary ingest options:

1. Bulk seed from `pokemon-tcg-data` or TCGdex database releases.
2. Incremental set/card reconciliation from Pokémon TCG API and TCGdex.
3. Preserve CollectFolio’s universal internal card ID.
4. Create external mappings rather than replacing the internal identity.

Minimum catalog fields:

```text
internal_card_id
name
supertype
subtypes
set_id
set_name
set_release_date
number
printed_total
rarity
artist
pokedex_numbers
language
variant
finish
image references
source mappings
```

### 15.4 Historical prices

The preferred production history is JustTCG's paid `priceHistoryDuration=1y` response, followed by daily prospective snapshots. Initial backfill points use the real retrieval time as `available_at`; their historical market dates must never be relabeled as proof that CollectFolio possessed the data at an earlier walk-forward origin. Provider storage remains app-bound and usable only while the paid license is active.

Because the free Supabase database cannot hold a full dense daily panel for every Pokémon printing indefinitely, use a tiered storage policy:

- **Latest price:** one compact row per active mapped card/variant.
- **Active-card daily history:** only cards owned, watched, modeled, or in benchmark cohorts.
- **Research backfill:** process historical archives during local/GitHub Actions jobs; retain compact derived weekly panels and metrics only when rights permit.
- **Raw restricted archives:** never publish through the app; keep outside public client access.

### 15.5 Pull-rate registry

Pull-rate data is curated, not scraped blindly.

Store:

```text
set_id
product_region
product_language
rarity_slot
sample_size
hit_count
probability
confidence_interval_lower
confidence_interval_upper
one_in_packs
eligible_card_count
specific_card_probability
specific_one_in_packs
equal_distribution_assumed
special_collation_notes
source_url
published_at
retrieved_at
review_status
```

Card-level specific probability:

\[
p_{specific} = \frac{p_{rarity}}{N_{eligible}}
\]

Expected packs:

\[
E[packs] = \frac{1}{p_{specific}}
\]

Do not treat expected packs as the number needed for a guaranteed hit. Also calculate 50%, 90%, and 95% hit-probability pack counts:

\[
n_q = \frac{\ln(1-q)}{\ln(1-p_{specific})}
\]

### 15.6 Sealed-product data

Store loose-pack, booster-box-derived, and collection-box-derived unit pack prices separately:

```text
sealed_product_id
set_id
product_type
packs_per_product
msrp
market_price
unit_pack_price
observed_at
source
```

Production scarcity features use pull probability independently from current sealed market price to reduce reverse causality.

### 15.7 Demand data

External:

- Wikimedia pageviews for character/topic attention.
- Optional Google Trends manual/API data when available.
- Event registry: reprints/restocks, anniversaries, new media, tournament relevance.

First party:

- Watchlist additions/removals.
- Search views.
- Card detail views.
- Portfolio adds.
- Scan confirmations.
- Alert creation.
- Pairwise artwork votes.

Only aggregate demand signals after a minimum privacy threshold, such as at least 20 distinct users in the aggregation window.

---

## 16. Data provenance and rights controls

### 16.1 Mandatory provenance fields

Every ingested observation must retain:

```text
source_id
source_record_id
source_url
source_observed_at
ingested_at
raw_payload_hash
parser_version
mapping_version
terms_review_version
public_raw_display_allowed
public_derived_display_allowed
```

### 16.2 Rights-aware publishing

The publishing job must enforce:

```text
public output allowed only when:
source is active
AND source terms review is current
AND raw/derived permission matches the output type
AND mapping confidence passes threshold
AND record is not quarantined
```

### 16.3 Image policy

Display priority:

1. User-owned crop/photo.
2. Explicitly licensed/approved catalog image.
3. Remote provider image only under verified terms and attribution.
4. Neutral placeholder.

The feature must work without permanently copying third-party Pokémon artwork.

---

## 17. Technical architecture

```text
                        ┌────────────────────────────┐
                        │ Public data/catalog sources│
                        └──────────────┬─────────────┘
                                       │
                              scheduled ingestion
                                       │
┌───────────────────┐        ┌────────▼─────────┐
│ Local operator run │───────▶│ GitHub Actions   │
│ restricted research│        │ analytics jobs   │
└───────────────────┘        └────────┬─────────┘
                                      │
                 mappings/features/models/evaluations
                                      │
                              ┌───────▼────────┐
                              │ Supabase       │
                              │ Postgres       │
                              │ + Storage      │
                              └───────┬────────┘
                                      │ permitted outputs only
                                      │
                              ┌───────▼────────┐
                              │ Netlify PWA    │
                              │ IndexedDB cache│
                              └────────────────┘
```

### 17.1 Runtime separation

**Browser JavaScript:**

- Watchlist CRUD.
- User settings.
- Cards/charts/detail rendering.
- Local cache.
- Supabase read/auth sync.
- Alert evaluation for received data.

**Python analytics package:**

- Source ingest.
- Mapping.
- Feature engineering.
- Model training.
- Walk-forward backtesting.
- Forecast generation.
- Outcome evaluation.
- Metrics publication.

### 17.2 Secret handling

- `SUPABASE_ANON_KEY`: browser-safe, provided to Netlify build.
- `SUPABASE_SERVICE_ROLE_KEY`: GitHub Actions secret only; never in app, repository, logs, or Netlify browser bundle.
- Provider API keys: GitHub Actions secret only unless provider explicitly supports browser-safe anonymous use.
- Research-only credentials: local operator environment or protected Actions environment.

---

## 18. Proposed repository structure

```text
app/
  assets/
    js/
      core/
        db.js
        store.js
        calculations.js
      services/
        forecast.js                # fetch/cache price intelligence
        watchlist.js               # local + cloud watchlist gateway
        alerts.js                  # in-app signal evaluation
        model-explanations.js      # deterministic driver copy
      views/
        portfolio.js               # add segmented navigation
        watchlist.js
        forecast-center.js
        price-intelligence-detail.js
        model-scorecard.js

analytics/
  pyproject.toml
  README.md
  configs/
    sources.yml
    cohorts.yml
    horizons.yml
    feature_flags.yml
  src/collectfolio_analytics/
    cli.py
    config.py
    provenance.py
    ingest/
      catalog.py
      prices.py
      pull_rates.py
      sealed.py
      wikimedia.py
    mapping/
      cards.py
      variants.py
      sets.py
    features/
      market.py
      trend.py
      structural.py
      character.py
      artwork.py
      demand.py
      lifecycle.py
      quality.py
    models/
      baselines.py
      fair_value.py
      forecast.py
      quantiles.py
      calibration.py
      registry.py
    validation/
      walk_forward.py
      grouped_splits.py
      leakage.py
      metrics.py
      cohort_reports.py
    publish/
      supabase.py
      artifacts.py
    evaluate/
      outcomes.py
      scorecards.py
  tests/

.github/workflows/
  catalog-sync.yml
  price-refresh.yml
  feature-build.yml
  forecast-weekly.yml
  evaluate-daily.yml
  retrain-monthly.yml
  research-backtest-manual.yml

supabase/migrations/
  0001_initial.sql
  0002_price_intelligence.sql

docs/
  PRICE_INTELLIGENCE_PRD.md
  DATA_SOURCE_REGISTER.md
  MODEL_CARD_TEMPLATE.md
  OPERATOR_RUNBOOK.md
  INCIDENT_RUNBOOK.md
```

---

## 19. Data model

### 19.1 Source governance

#### `data_sources`

```text
id
code
name
source_type
terms_url
commercial_use_allowed
public_raw_display_allowed
public_derived_display_allowed
attribution_required
attribution_text
review_status
reviewed_at
review_notes
active
```

#### `source_ingestion_runs`

```text
id
source_id
started_at
completed_at
status
records_read
records_written
records_quarantined
raw_payload_hash
parser_version
error_summary
```

### 19.2 Catalog and mapping

#### `catalog_sets`

```text
id
name
series
language
release_date
printed_total
total
source_payload
created_at
updated_at
```

#### `catalog_cards`

```text
id
set_id
name
number
rarity
artist
supertype
subtypes
pokedex_numbers
release_date
created_at
updated_at
```

#### `catalog_variants`

```text
id
card_id
language
edition
finish
variant_name
raw_condition_class
canonical_key
active
```

#### `external_card_mappings`

```text
id
source_id
external_product_id
variant_id
mapping_confidence
mapping_method
mapping_version
review_status
reviewed_by
reviewed_at
```

### 19.3 Market data

#### `latest_prices`

```text
variant_id
source_id
price_subtype
currency
market_price
low_price
mid_price
high_price
observed_at
ingested_at
quality_score
public_display_allowed
```

#### `price_snapshots`

```text
id
variant_id
source_id
price_subtype
currency
market_price
observed_at
quality_score
source_record_hash
```

Only active cards receive dense rows in the free-tier pilot.

### 19.4 Pull and sealed data

#### `pull_rate_sources`

```text
id
publisher
title
url
published_at
retrieved_at
sample_size
methodology
region
language
confidence_grade
```

#### `set_pull_rates`

```text
id
set_id
source_id
rarity_slot
probability
ci_lower
ci_upper
one_in_packs
eligible_count
specific_probability
specific_one_in_packs
equal_distribution_assumed
collation_notes
effective_from
effective_to
version
```

#### `sealed_products` / `sealed_price_snapshots`

Maintain product type and packs-per-product so unit pack price is reproducible.

### 19.5 Watchlist and alerts

#### `watchlists`

```text
id
user_id
name
is_default
created_at
updated_at
```

#### `watchlist_items`

```text
id
watchlist_id
user_id
variant_id
target_price
alert_percent_change
alert_trend_change
alert_range_change
alert_forecast_change
notes
created_at
updated_at
```

#### `watchlist_deletions`

Sync-safe tombstones matching the existing holdings pattern.

#### `alert_events`

```text
id
user_id
variant_id
alert_type
event_key
payload
triggered_at
read_at
```

### 19.6 Demand and artwork

#### `demand_events`

Private, user-linked event stream with limited retention.

#### `aggregate_demand_snapshots`

```text
variant_id
period_start
period_end
watch_adds
watch_removes
searches
portfolio_adds
views
unique_users
privacy_threshold_met
```

#### `artwork_pairwise_votes`

```text
id
user_id
variant_a_id
variant_b_id
winner_variant_id
presented_at
created_at
```

#### `artwork_score_snapshots`

```text
variant_id
model_version
score
lower_bound
upper_bound
vote_count
calculated_at
```

### 19.7 Model registry and outputs

#### `model_versions`

```text
id
model_type
name
version
cohort
horizon_days
code_commit
training_cutoff
feature_version
dataset_hash
parameters
status
created_at
promoted_at
```

#### `model_runs`

```text
id
model_version_id
run_type
prediction_origin
feature_cutoff
started_at
completed_at
status
row_count
artifact_uri
metrics
```

#### `card_fair_value_estimates`

```text
variant_id
model_run_id
observed_price
estimate_q10
estimate_q25
estimate_q50
estimate_q75
estimate_q90
position
confidence_score
feature_contributions
public_display_allowed
generated_at
```

#### `card_forecasts`

```text
id
variant_id
model_run_id
horizon_days
prediction_origin
matures_at
current_price
return_q10
return_q25
return_q50
return_q75
return_q90
price_q10
price_q25
price_q50
price_q75
price_q90
probability_up
confidence_score
feature_snapshot_hash
public_display_allowed
created_at
```

#### `prediction_evaluations`

```text
forecast_id
evaluation_rule
realized_price
realized_return
absolute_error
percentage_error
log_return_error
direction_correct
interval_50_hit
interval_80_hit
status
evaluated_at
```

#### `model_metrics`

Store results by model, horizon, cohort, time period, lifecycle, set, and price tier.

---

## 20. RLS and access model

### Private user tables

- Watchlists.
- Watchlist items and deletions.
- Alert events.
- Raw demand events.
- Artwork votes.

Policies: authenticated users can access only rows where `user_id = auth.uid()`.

### Public/reference tables

- Catalog identity.
- Approved latest prices.
- Approved fair-value estimates.
- Approved forecasts.
- Public model scorecards.
- Aggregate demand after privacy threshold.

Clients receive read-only access through filtered views. Direct base-table writes remain service-role only.

### Restricted research tables

- Restricted-source raw prices.
- Raw model features.
- Private research outputs.
- Ingestion logs.
- Quarantine records.

No anon/authenticated grants.

---

## 21. Scheduled jobs

### 21.1 `catalog-sync.yml`

**Cadence:** Weekly + manual.  
**Purpose:** Ingest new sets/cards and reconcile metadata.  
**Output:** Catalog changes, mapping candidates, coverage report.

### 21.2 `price-refresh.yml`

**Cadence:** Daily, off the top of the hour.  
**Purpose:** Refresh permitted latest prices and active-card history.  
**Rules:** Skip if source timestamp has not changed; respect source polling guidance.

### 21.3 `feature-build.yml`

**Cadence:** Daily after price refresh.  
**Purpose:** Build trend, structural, lifecycle, demand, and quality features using one point-in-time cutoff.

### 21.4 `forecast-weekly.yml`

**Cadence:** Weekly.  
**Purpose:** Generate immutable forecasts from champion models for eligible active cards.

### 21.5 `evaluate-daily.yml`

**Cadence:** Daily.  
**Purpose:** Evaluate matured forecasts and update scorecards.

### 21.6 `retrain-monthly.yml`

**Cadence:** Monthly.  
**Purpose:** Train champion/challenger candidates, run walk-forward validation, and publish a review packet. No automatic promotion.

### 21.7 `research-backtest-manual.yml`

**Cadence:** Manual only.  
**Purpose:** Run restricted-source historical experiments and produce private artifacts for operator review.

Scheduled GitHub workflows run from the default branch. Public-repository schedules may be disabled after prolonged inactivity, so the operator runbook must include re-enablement checks.

---

## 22. Mapping strategy

### 22.1 Canonical matching key

A variant key should combine:

```text
game
language
set identity
card number
normalized name
edition
finish
variant markers
```

### 22.2 Mapping methods

1. Exact external ID previously approved.
2. Exact set + number + variant match.
3. Exact set + number + finish, with normalized name confirmation.
4. Fuzzy candidate requiring operator review.
5. Unmapped.

### 22.3 Confidence thresholds

- `1.00`: manually approved or exact immutable source mapping.
- `>=0.98`: safe for automated update when all identity fields agree.
- `0.85–0.9799`: review queue.
- `<0.85`: no automated price attachment.

### 22.4 Mapping safety

A source price may never attach solely by card name. Pokémon cards frequently repeat names across sets and printings.

---

## 23. Feature engineering

### 23.1 Market features

For every eligible origin:

```text
price_current
return_7d
return_30d
return_90d
return_180d
return_365d
robust_slope_30d
robust_slope_90d
momentum_acceleration
volatility_30d
volatility_90d
max_drawdown_180d
distance_from_52w_high
distance_from_52w_low
history_density
staleness_hours
source_quality
source_disagreement
```

Use log returns:

\[
r_{t,h}=\ln\left(\frac{P_t}{P_{t-h}}\right)
\]

### 23.2 Trend classification

Use robust slope and volatility-adjusted thresholds. Avoid classifying noise as momentum.

Example:

```text
strong_rise: slope_z >= 1.5 and data_quality >= threshold
rise:        0.5 <= slope_z < 1.5
stable:     -0.5 < slope_z < 0.5
fall:       -1.5 < slope_z <= -0.5
strong_fall: slope_z <= -1.5
```

Thresholds must be calibrated from historical volatility rather than hard-coded permanently.

### 23.3 Scarcity features

```text
specific_pull_probability
negative_log_specific_probability
expected_packs
packs_for_50_percent_hit
packs_for_90_percent_hit
packs_for_95_percent_hit
pull_rate_ci_width
pull_source_confidence
rarity_pool_size
```

Treat:

- Guaranteed promos as `not_applicable`.
- Unknown vintage pull rates as `unknown`.
- Special collation explicitly.

### 23.4 Character premium

Do not use the target card’s own current or future price.

Recommended feature:

1. Fit a baseline price model controlling for set, rarity, age, finish, and period.
2. Calculate prior-card residuals.
3. Aggregate residuals by Pokémon character.
4. Apply partial pooling/shrinkage for characters with few eligible cards.
5. Store estimate and uncertainty.

Multi-Pokémon cards can use weighted or multi-hot character effects.

### 23.5 Artwork and artist features

- Blind pairwise artwork score.
- Vote count and uncertainty.
- Artist historical residual premium.
- Time since last high-rarity printing for the character.
- Artwork novelty/duplication indicators only if objectively reproducible.

Do not infer an “art score” from current price.

### 23.6 Lifecycle features

```text
days_since_release
release_month
presale_flag
first_30_days
31_to_90_days
91_to_180_days
181_to_365_days
one_to_two_years
over_two_years
reprint_event_age
restock_event_age
rotation_state
```

### 23.7 Demand features

```text
watchlist_velocity_7d
watchlist_velocity_30d
search_velocity_7d
portfolio_add_velocity_30d
view_velocity_7d
alert_creation_velocity
artwork_score
wikimedia_pageview_index
demand_acceleration
```

Normalize first-party signals by active-user count and protect against repeated self-generated events.

### 23.8 Data-quality features

```text
mapping_confidence
source_freshness
history_completeness
price_null_rate
outlier_rate
pull_rate_confidence
artwork_uncertainty
character_sample_size
cohort_training_size
```

---

## 24. Modeling system

### 24.1 Layer A — observed market

Create a source-specific observation and, only when permitted and statistically justified, a robust composite:

\[
P_{observed}=\text{weighted median of valid source observations}
\]

Weights reflect freshness, source class, mapping certainty, and market semantics.

### 24.2 Layer B — trend engine

Recommended methods:

- Exponentially weighted returns.
- Theil–Sen or similarly robust slope.
- Median absolute deviation volatility.
- Drawdown and acceleration.

This layer contains no future target.

### 24.3 Layer C — structural fair-value model

Target:

\[
y_{i,t}=\ln(P_{i,t})
\]

Transparent baseline:

\[
\ln(P_{i,t}) = \alpha + f_1(-\ln p_{specific}) + f_2(age) +
\beta_D D_{i,t}+\beta_L L_{i,t}+u_{set}+u_{character}+u_{artist}+\epsilon
\]

Where:

- `D` = demand bundle.
- `L` = market quality/liquidity proxy.
- `u` terms = regularized group effects.
- `f` functions = nonlinear transformations/splines.

Recommended baseline implementation:

- Regularized linear/GAM-style model on log price.
- Robust loss or outlier controls.
- Quantile outputs or residual-based calibrated intervals.

Challenger:

- Histogram gradient boosting with quantile loss.

### 24.4 Layer D — horizon forecasts

Forecast future log return directly:

\[
r_{i,t,h}=\ln\left(\frac{P_{i,t+h}}{P_{i,t}}\right)
\]

Train independent models for:

```text
h = 7, 30, 90, 180, 365 days
```

Do not recursively apply a one-day model 365 times.

Recommended v1 model family:

- Elastic-net median baseline.
- Histogram gradient boosting quantile models for q10/q25/q50/q75/q90.
- Probability-up model or calibrated empirical probability derived from the return distribution.

### 24.5 Required baselines

Every horizon must compare against:

1. **No change:** future price equals current price.
2. **Damped momentum:** continue a fraction of recent trend.
3. **Market index:** card moves with its cohort index.
4. **Lifecycle cohort:** median future path of similar-age/similar-rarity cards.
5. **Structural convergence:** a learned fraction of fair-value gap closes.

A production model must beat at least the no-change baseline and the strongest simple challenger on declared primary metrics.

### 24.6 Model 0

Preserve the video reconstruction separately:

\[
\ln(P)=2.418749626+0.177451739(PullScore)+0.341586702(Desirability)
\]

With legacy pull score:

\[
PullScore=10\times\frac{PullCost}{18446}
\]

Model 0 is for:

- Reproduction.
- Educational comparison.
- Ablation testing.
- Testing whether structural gap predicts future returns.

It is not the production forecast.

---

## 25. Walk-forward validation

### 25.1 Core rule

At origin `t`, every feature must be known by `t`, and every training label must have matured before `t`.

For a horizon `h`, a training row is eligible only when:

```text
feature_date + h <= training_cutoff
```

### 25.2 Rolling-origin process

For each monthly origin:

1. Freeze source data at the origin.
2. Build features using only prior information.
3. Train or load the model permitted by the experiment.
4. Predict each eligible card at all supported horizons.
5. Advance to the next origin.
6. Evaluate only after each horizon matures.

### 25.3 Test regimes

- Existing-card future forecasting.
- Unseen-card forecasting.
- Leave-one-set-out forecasting.
- Lifecycle cohorts.
- Rising/falling/stable/high-volatility market regimes.
- Price tiers.
- Rarity cohorts.
- New releases versus mature cards.

### 25.4 Leakage tests

Automated tests must fail the run when:

- Feature timestamp exceeds cutoff.
- Target card appears in its own character aggregation.
- Future release appears in prior feature universe.
- Outcome period overlaps training improperly.
- Same card/set group leaks across a declared grouped test.
- Revised mapping/data is substituted into an old point-in-time snapshot without versioning.

### 25.5 Evaluation price

Default realized value:

```text
trailing seven-day median ending at maturity date
```

Store the exact-date observation separately. Require matching source semantics, variant, finish, currency, and raw/graded class.

### 25.6 Metrics

Point metrics:

- MAE in log return.
- Median absolute percentage error.
- Symmetric MAPE.
- Median absolute error in dollars by price tier.
- Baseline-relative MASE or equivalent lift.

Direction/probability:

- Direction accuracy.
- Accuracy for moves exceeding ±10% and ±25%.
- Brier score for positive-return probability.
- Probability calibration.

Intervals:

- Pinball loss by quantile.
- 50% interval coverage.
- 80% interval coverage.
- Mean interval width.
- Calibration error.

### 25.7 Promotion gates

A challenger cannot become champion unless:

- It passes all leakage tests.
- It improves the primary metric over the current champion and no-change baseline.
- Its interval coverage is acceptably calibrated.
- Improvement persists across multiple rolling origins.
- No critical cohort degrades beyond tolerance.
- Source and derived-output rights permit production use.
- An operator approves the model card.

---

## 26. Confidence system

Confidence is a 0–100 evidence score, not a guarantee.

Recommended weighted components:

| Component | Weight |
|---|---:|
| Price/source freshness and quality | 20% |
| History completeness | 15% |
| Mapping confidence | 15% |
| Cohort training support | 15% |
| Interval width/calibration | 15% |
| Feature completeness | 10% |
| Pull-rate confidence/applicability | 5% |
| Source agreement | 5% |

Hard caps:

- Unresolved mapping: no forecast.
- Restricted output: no public forecast.
- Less than minimum history: confidence capped or no forecast.
- Very wide q10–q90 range: confidence capped.
- New card outside supported lifecycle: confidence capped.

Labels:

```text
80–100 High
60–79 Medium
40–59 Medium-low
20–39 Low
0–19 Insufficient
```

---

## 27. API/read-contract design

The PWA should use Supabase REST views or RPCs.

### `card_intelligence_summary`

```json
{
  "variantId": "uuid",
  "supportTier": 4,
  "observed": {
    "price": 802.0,
    "currency": "USD",
    "source": "approved_source",
    "observedAt": "2026-08-04T20:00:00Z",
    "quality": 0.86
  },
  "trend": {
    "return30d": 0.182,
    "return90d": 0.241,
    "status": "strong_rise",
    "volatility": 0.37,
    "confidence": 72
  },
  "fairValue": {
    "q10": 510,
    "q50": 620,
    "q90": 730,
    "position": "above_range",
    "confidence": 64
  },
  "forecasts": {
    "365": {
      "q10": 540,
      "q25": 720,
      "q50": 845,
      "q75": 990,
      "q90": 1210,
      "probabilityUp": 0.58,
      "confidence": 47,
      "origin": "2026-08-01T00:00:00Z",
      "maturesAt": "2027-08-01T00:00:00Z",
      "modelVersion": "pokemon_raw_365d_v1.3"
    }
  }
}
```

### `card_prediction_history`

Paginated immutable forecast/evaluation records.

### `model_scorecard`

Returns public metrics by horizon/cohort and model version.

### Caching

- IndexedDB cache keyed by variant + model run.
- Latest summary TTL: 6–24 hours depending on source cadence.
- Prediction history immutable and cacheable long term.
- Service worker may cache approved JSON responses but must not cache restricted research endpoints.

---

## 28. Free-tier capacity plan

Current free Supabase constraints make full dense history for every Pokémon printing inappropriate in Postgres.

### Database allocation target

Keep under approximately 350 MB to retain operational margin:

| Area | Pilot target |
|---|---:|
| Existing user data | 75 MB |
| Catalog/mappings | 75 MB |
| Latest prices | 25 MB |
| Active-card price history | 75 MB |
| Watchlists/alerts/events | 25 MB |
| Model outputs/evaluations/metrics | 50 MB |
| Headroom/index growth | 25+ MB |

### Storage policy

- Partition compressed analytics artifacts under the free plan’s per-file maximum.
- Retain only artifacts required for reproducibility and permitted by source terms.
- Do not store every third-party image.
- Do not store unrestricted raw TCGCSV archives in publicly accessible storage.
- Delete or compact superseded nonessential research artifacts after checksums/model lineage are preserved.

### Compute policy

- Heavy Python work runs on standard GitHub-hosted public-repository runners.
- Supabase Cron handles short SQL maintenance/evaluation tasks only.
- Netlify performs static build/deploy only.
- No browser-triggered retraining.

---

## 29. Privacy, safety, and abuse resistance

### 29.1 User data

- Watchlists are private by default.
- Holdings remain private.
- Raw demand events are never public.
- User images remain local unless the user explicitly syncs an eligible compressed image under existing rules.

### 29.2 Aggregate demand

- Minimum distinct-user threshold before publication/use.
- Rate-limit repeated events per user/device/card.
- Deduplicate rapid repeated actions.
- Exclude operator/test accounts.
- Detect coordinated vote/watch manipulation.
- Permit users to opt out of aggregated analytics.

### 29.3 Prediction safety

- Display “estimate,” “modeled range,” and “historical performance.”
- Avoid investment-language claims.
- Show data freshness and confidence.
- Clearly identify estimates that are research-only.

---

## 30. Model governance

Every production model needs a model card containing:

```text
model ID/version
purpose
supported cohort
unsupported cohort
training cutoff
training data sources and rights status
feature list
hyperparameters
validation design
metrics by horizon/cohort
baseline comparison
interval calibration
known limitations
approval actor/date
rollback model
```

### Champion/challenger policy

- Champion serves users.
- Challengers generate shadow forecasts.
- Shadow forecasts remain private until evaluated.
- Promotion is manual.
- Rollback is one flag change.

### Incident triggers

Quarantine the model/source when:

- Mapping error affects material cards.
- Source terms change.
- Interval coverage collapses.
- Prediction bias exceeds threshold.
- Data refresh stops.
- Source values diverge abnormally.
- Leakage is discovered.

---

## 31. Edge cases and states

| State | Required behavior |
|---|---|
| No price | Watch allowed; intelligence unavailable |
| Stale price | Display age and downgrade confidence |
| New release | Trend limited; forecast only through supported lifecycle cohort and low confidence |
| Reprint/restock | Event marker; widen uncertainty/recompute features |
| Manual value | Portfolio uses manual value; model keeps provider series separate |
| Variant ambiguity | No automated intelligence until resolved |
| Graded card | Route to unsupported/grade-specific future model |
| Missing pull rate | Fair-value model uses missing indicator; explains limitation |
| Guaranteed promo | Pull scarcity marked not applicable |
| Extreme price spike | Quarantine/outlier flag; do not silently smooth it away |
| Provider outage | Last-known data stays visible with stale warning |
| Model unavailable | Trend and observed price continue working |
| Restricted source | Hide raw/derived public output; show “data unavailable” rather than source details |
| Prediction not matured | Show open status and maturity date |
| Unscorable outcome | Exclude from error metric denominator and report count |

---

## 32. Success metrics

### Product

- Percentage of active collectors using Watchlist.
- Watchlist-to-card-detail engagement.
- Alert open rate.
- Retention among watchlist users versus non-watchlist users.
- Percentage of owned Pokémon cards with at least Trend support.
- Percentage of watched Pokémon cards with Forecast support.
- User comprehension of range/confidence in usability testing.

### Data operations

- Price refresh success rate.
- Mapping automation rate.
- Mapping error rate.
- Data freshness SLA.
- Quarantined-record rate.
- Source-policy violations: target zero.

### Model

- Baseline lift by horizon.
- MdAPE/sMAPE by horizon.
- Direction accuracy.
- Brier score.
- 50%/80% interval coverage.
- Forecast availability and confidence distribution.
- Performance by lifecycle and price tier.

---

## 33. Rollout plan

### Phase 0 — rights and source gate

Deliver:

- Data-source register.
- TCGplayer/TCGCSV production-use decision.
- Pokémon image/IP review.
- Source capability/permission flags.
- Research-only feature flag.

Exit criterion: every planned production source has documented permitted use.

### Phase 1 — watchlist and intelligence shell

Deliver:

- Watchlist local/cloud data model.
- Portfolio segmented navigation.
- Card intelligence UI states.
- Manual/approved observed price support.
- In-app alerts.
- No forecasting required.

### Phase 2 — data foundation and trend engine

Deliver:

- Catalog/mapping tables.
- Approved latest-price ingest.
- Active-card historical snapshots.
- 7/30/90/180/365 trend metrics.
- Data quality and support tiers.

### Phase 3 — research and Model 0 benchmark

Deliver:

- Forensic Model 0 implementation.
- Restricted historical research pipeline.
- Baseline models.
- Walk-forward framework.
- Leakage test suite.

### Phase 4 — structural fair value pilot

Initial cohort:

- Modern English raw Pokémon chase cards.
- Supported pull-rate sets.
- Sufficient price history.

Deliver calibrated structural ranges and explanations.

### Phase 5 — probabilistic forecasts

Deliver:

- Direct 7/30/90/180/365 models.
- Immutable prediction ledger.
- Daily maturity evaluation.
- Scorecards.
- Champion/challenger registry.

### Phase 6 — first-party demand moat

Deliver:

- Aggregate watch/search/portfolio signals.
- Pairwise artwork voting.
- Demand-velocity features.
- Privacy and abuse controls.

### Phase 7 — expansion

Only after independent validation:

- Wider English raw universe.
- Japanese/language-specific models.
- Graded-card cohorts.
- Other TCGs.
- Sports cards and comics using separately licensed data and models.

---

## 34. Testing plan

### Unit tests

- Return calculations.
- Quantile-to-price transformation.
- Pull-probability calculations.
- Hit-probability pack counts.
- Mapping keys.
- Confidence score caps.
- Trend classifications.
- Alert deduplication.
- RLS ownership helpers.

### Data-contract tests

- Required provenance fields.
- Source-policy flags.
- Variant identity uniqueness.
- Timestamp ordering.
- Currency and subtype consistency.
- Null/outlier quarantine.

### Leakage tests

- No future feature timestamps.
- No unmatured labels.
- No target in character/art aggregates.
- No same-group leakage in held-out tests.

### Model tests

- Deterministic seed/reproducibility.
- Baseline comparison.
- Quantile ordering: q10 ≤ q25 ≤ q50 ≤ q75 ≤ q90.
- Coverage report.
- Cohort minimums.
- Model artifact/hash consistency.

### Browser tests

- Watch/unwatch across all entry points.
- Offline watchlist persistence.
- Signed-in watchlist sync and deletion.
- Detail charts at mobile/desktop sizes.
- Unsupported/stale/restricted states.
- Screen-reader labels and keyboard navigation.
- Reduced motion.

### Operational tests

- Scheduled job rerun/idempotency.
- Provider outage recovery.
- Mapping correction propagation.
- Model rollback.
- Source quarantine.
- Free-tier storage monitoring.

---

## 35. Acceptance criteria

The feature is complete for its first public cohort when:

1. Existing Holdings behavior remains intact.
2. Portfolio shows Holdings, Watchlist, and Forecasts without adding a bottom-navigation item.
3. A user can watch/unwatch an exact Pokémon variant locally.
4. Signed-in watchlist additions and deletions synchronize under RLS.
5. A watched or owned supported card shows observed price, source, and freshness.
6. Supported cards show 7/30/90/180/365-day trend metrics.
7. Unsupported/stale/restricted cards show explicit reasons rather than fabricated values.
8. Structural fair value is displayed as a range with position and confidence.
9. Forecast-supported cards show q10/q25/q50/q75/q90 for each available horizon.
10. Forecast UI displays median, 50% range, 80% range, probability up, confidence, origin, maturity, and model version.
11. Existing forecasts are immutable.
12. Matured forecasts are evaluated automatically using the declared evaluation rule.
13. Prediction history shows forecast versus realized outcome.
14. Model scorecards use held-out/prospective results and report baseline comparisons.
15. Automated leakage tests pass.
16. Quantile-ordering and interval-calibration tests pass.
17. Public outputs are filtered by source and derived-output permission flags.
18. Restricted research data is not accessible through anon/authenticated APIs.
19. Model drivers are generated from recorded contributions/rules, not fabricated text.
20. No user sees buy/sell or guaranteed-price language.
21. Data jobs are idempotent and preserve provenance.
22. Static Netlify build continues to require no paid compute.
23. Supabase usage remains under agreed free-tier budgets with monitoring.
24. GitHub Actions workflows can be run manually and on schedule from the default branch.
25. A rollback flag can disable forecast display without affecting watchlists or holdings.

---

## 36. Operator actions required before build completion

1. Decide whether this is initially a private research feature or a public user feature.
2. Subscribe the operating entity to a paid JustTCG plan; archive and hash the exact accepted contract and record a current immutable source review.
3. Obtain separate written clarification/permission before using TCGplayer/TCGCSV-derived data or derivatives publicly.
4. Decide whether Pokémon catalog imagery will be displayed remotely, cached, replaced with user images, or withheld pending legal review.
5. Create server-side secrets for Supabase service-role access and `JUSTTCG_API_KEY`; never expose either to the browser.
6. Apply migration 0006 only after a restorable backup and rollback rehearsal.
7. Choose and exact-map the initial production cohort and minimum history thresholds.
8. Approve the model scorecard and user-facing uncertainty language.
9. Approve privacy thresholds for aggregate demand signals.

---

## 37. Open decisions

### Required before production data integration

- Activate the preferred JustTCG paid provider or document a signed alternative.
- Record the paid plan's raw-display and derived-analytics rights in an unexpired immutable review.
- Exact condition/finish semantics.
- Voluntary source attribution copy; recommended: “Market data provided by JustTCG.”

### Required before model launch

- Minimum price-history days per horizon.
- Minimum non-null density.
- Minimum cohort size.
- Primary promotion metric.
- Acceptable 80% interval-coverage band.
- Confidence thresholds.
- New-release forecast policy.

### Can be decided during implementation

- Exact segmented-control styling.
- Chart library versus existing Canvas renderer.
- Internal Python packaging details.
- Exact job minute offsets.
- Operator-dashboard layout.

---

## 38. Recommended implementation order

1. Data-source and rights registry.
2. Watchlist schema and UI.
3. Catalog mapping foundation.
4. Approved current-price ingest.
5. Active-card history and trend engine.
6. Prediction/model registry and immutable ledger.
7. Walk-forward and leakage framework.
8. Model 0 benchmark.
9. Structural fair-value model.
10. Quantile forecasts.
11. Outcome evaluator and scorecards.
12. First-party demand/artwork signals.

This ordering prevents a polished forecast UI from being built on data that cannot legally or statistically support it.

---

## 39. Source register

### Project sources

- Current CollectFolio repository README and technical specification.
- Existing Supabase migration `0001_initial.sql`.
- User-supplied video transcript and screenshots.
- `CollectFolio-video-model-forensic-reconstruction.xlsx`.

### Catalog and metadata

- Pokémon TCG API documentation: https://docs.pokemontcg.io/
- Pokémon TCG API rate limits: https://docs.pokemontcg.io/getting-started/rate-limits/
- Pokémon TCG API authentication: https://docs.pokemontcg.io/getting-started/authentication/
- Pokémon TCG raw data: https://github.com/PokemonTCG/pokemon-tcg-data
- TCGdex: https://tcgdex.dev/
- TCGdex database: https://github.com/tcgdex/cards-database

### Market and listings

- JustTCG terms and commercial-use guidance: https://justtcg.com/terms and https://justtcg.com/docs/commercial-use
- JustTCG pricing, limits, and cards API: https://justtcg.com/pricing, https://justtcg.com/docs/rate-limits, and https://justtcg.com/docs/api/cards
- JustTCG variant schema and one-year history changelog: https://justtcg.com/docs/schema/variant and https://justtcg.com/docs/changelog
- TCGCSV documentation: https://tcgcsv.com/docs
- TCGCSV FAQ/archive: https://tcgcsv.com/faq
- TCGplayer API terms: https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions
- eBay Browse API: https://developer.ebay.com/api-docs/buy/static/api-browse.html
- eBay API call limits: https://developer.ebay.com/develop/get-started/api-call-limits
- PriceCharting API docs: https://www.pricecharting.com/api-documentation
- PriceCharting terms: https://www.pricecharting.com/page/terms-of-service

### Pull rates

- TCGplayer pull-rate articles, beginning with the modern set registry; examples:
  - Prismatic Evolutions: https://www.tcgplayer.com/content/article/Pok%C3%A9mon-TCG-Prismatic-Evolutions-Pull-Rates/d94889ea-f76a-4a13-b74d-5b0b071220a7/
  - Mega Evolution: https://www.tcgplayer.com/content/article/Pok%C3%A9mon-TCG-Mega-Evolution-Pull-Rates/40cbeedc-21ce-473b-aef1-74e3969d9f91/
  - Phantasmal Flames: https://www.tcgplayer.com/content/article/Pok%C3%A9mon-TCG-Phantasmal-Flames-Pull-Rates/9abae60d-b7fb-448f-874e-176f78d6a6ca/

### Demand

- Wikimedia Analytics API: https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/
- Wikimedia access policy: https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html
- Google Trends API alpha: https://developers.google.com/search/apis/trends

### Infrastructure and modeling

- Supabase pricing/limits: https://supabase.com/pricing
- Supabase Cron: https://supabase.com/docs/guides/cron
- GitHub-hosted runners: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- GitHub scheduled workflow behavior: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- scikit-learn `TimeSeriesSplit`: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html
- scikit-learn `GroupKFold`: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.GroupKFold.html
- scikit-learn quantile prediction intervals: https://scikit-learn.org/stable/auto_examples/ensemble/plot_gradient_boosting_quantile.html

### Pokémon IP guidance

- Pokémon Support, image/material use: https://support.pokemon.com/hc/en-us/articles/360000634094-Can-I-use-Pok%C3%A9mon-images-or-materials

---

## 40. Final product contract

CollectFolio Price Intelligence is successful when a collector can answer:

> What is this exact card worth according to the permitted source, how has it moved, what structurally supports or challenges that price, what future range does the model assign, how confident is it, and how has the model historically performed?

The system is not complete merely because it produces a number. It is complete when the number is **mapped correctly, sourced lawfully, timestamped, reproducible, uncertainty-aware, walk-forward evaluated, and understandable to the user.**
