// Token Radar model: turns the sealed DefiLlama snapshot into a ranked board of
// pre-token protocols. Every number on the board is derived from the snapshot's
// own figures — nothing is hardcoded per protocol.
//
// Method, in one paragraph: a protocol is a radar candidate when DefiLlama
// records no token for it (gecko_id and symbol both null) and it is not a
// wrapped, staked, bridged or versioned product of something that already
// trades. Each candidate's implied launch value is its TVL multiplied by the
// median market-cap/TVL multiple of already-tokenized protocols in the same
// category (computed from this same snapshot), then adjusted by four small
// factors the snapshot itself supplies: 7-day TVL momentum, years running
// without a token, chain breadth, and a size dampener for billion-dollar TVLs.
// Each candidate also carries launch odds — its category's launch base rate
// in this same snapshot, shrunk toward the market rate — and an expected
// value (implied × odds). Finally, the model grades itself out-of-sample:
// every traded protocol is predicted once by tables fitted without it, and
// those scores are published in the radar's evidence block.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Factors {
  momentum: number;
  maturity: number;
  breadth: number;
  dampener: number;
}

export interface Row {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export interface RadarRow extends Row {
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_years: number | null;
  watchlist: boolean;
  multiple: number;
  multiple_n: number;
  factors: Factors;
  odds: number;
  odds_rate: number;
  odds_n: number;
  odds_launched: number;
  expected_value_usd: number;
  farm_cost: string;
  farm_time: string;
}

/**
 * The model grading itself, computed from the snapshot at run time: every
 * protocol that already trades a token is predicted once by a model fitted
 * without it (two slug-hash halves, both directions), so these numbers are
 * out-of-sample by construction — see heldOutEvidence.
 */
export interface Evidence {
  value_tested: number;
  value_median_factor: number;
  value_within_2x: number;
  value_within_3x: number;
  value_spearman: number;
  odds_tested: number;
  odds_brier_model: number;
  odds_brier_naive: number;
  odds_brier_gain: number;
}

export interface Radar {
  as_of: string;
  source: string;
  floor_usd: number;
  stats: {
    protocols: number;
    tokenized: number;
    tokenless: number;
    excluded: number;
    candidates: number;
    watchlist: number;
    total_implied_usd: number;
    global_multiple: number;
    global_launch_rate: number;
  };
  multiples: { category: string; n: number; multiple: number }[];
  evidence: Evidence;
  rows: RadarRow[];
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

/** DefiLlama records no token for the protocol: both token fields are null. */
export function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const WRAPPER_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Why a tokenless protocol is still not a launch candidate, or null when it is
 * one. Mirrors the snapshot's own watchlist rule: a V2 of a traded protocol, a
 * wrapped or staked product of a traded token, and an exchange's own product
 * are not protocols waiting on a launch of their own.
 */
export function exclusionReason(p: Protocol): string | null {
  if (VERSIONED.test(p.name)) return 'versioned name: a later version of a protocol, not a new launch';
  if (p.category !== null && WRAPPER_CATEGORIES.has(p.category)) {
    return `category ${p.category}: a wrapped, staked or bridged product of a token that already trades`;
  }
  if (WRAPPED_WORD.test(p.name)) return 'name marks it as a wrapped or staked product of another token';
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return 'an exchange product, not an independent launch';
  return null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const RATIO_FLOOR = 0.02;
const RATIO_CAP = 3.0;

export interface MultipleTable {
  global: number;
  byCategory: Map<string, { n: number; multiple: number }>;
}

/**
 * The value model’s anchor: for every category, the median market-cap/TVL of
 * the protocols in that category whose token already trades, with each ratio
 * winsorized to [0.02, 3] so one runaway token cannot bend a whole category.
 * Each category’s own median is then blended toward the global median in log
 * space, weighted by its evidence: w = n/(n+4) of the category, the rest the
 * market. Eleven traded peers keep most of their category’s character; a
 * single peer — whose token price may have nothing to do with its TVL, as
 * with an old oracle token over a new curator business — moves the blend
 * only a fifth of the way, so it cannot outvote the whole market.
 */
export function categoryMultiples(protocols: Protocol[]): MultipleTable {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (recordsNoToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const r = Math.min(RATIO_CAP, Math.max(RATIO_FLOOR, p.mcap_usd / p.tvl_usd));
    all.push(r);
    const key = p.category ?? 'Uncategorized';
    const list = ratios.get(key) ?? [];
    list.push(r);
    ratios.set(key, list);
  }
  const global = median(all);
  const byCategory = new Map<string, { n: number; multiple: number }>();
  for (const [key, list] of ratios) {
    const n = list.length;
    const w = n / (n + 4);
    const blended = Math.exp(w * Math.log(median(list)) + (1 - w) * Math.log(global));
    byCategory.set(key, { n, multiple: blended });
  }
  return { global, byCategory };
}

export function multipleFor(table: MultipleTable, category: string | null): { n: number; multiple: number } {
  const hit = table.byCategory.get(category ?? 'Uncategorized');
  return hit ?? { n: 0, multiple: table.global };
}

/** Whole years between the day DefiLlama began tracking the protocol and the snapshot date. */
export function ageYears(p: Protocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const ms = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${p.listed_at}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor((ms / 86_400_000 / 365.25) * 10) / 10;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * The four adjustments, each computed only from the candidate’s own snapshot
 * fields, each deliberately small: the category multiple does the heavy
 * lifting and these only tilt it.
 * - momentum: TVL growing into a launch is worth more; ±15% at most, from the
 *   7-day change clamped to ±30 points so one freak print cannot dominate.
 * - maturity: every year live without a token adds 5%, up to +20% — a product
 *   that survived years tokenless has users a launch can be priced on.
 * - breadth: each extra chain beyond the first adds 1%, up to +9% — more
 *   chains is more distribution surface for a new token.
 * - dampener: above $1B of TVL the multiple compresses, because billion-dollar
 *   protocols do not launch at full category multiples; floored at 0.55.
 */
export function factorsFor(p: Protocol, age: number | null): Factors {
  const momentum = p.change_7d === null ? 1 : 1 + clamp(p.change_7d, -30, 30) * 0.005;
  const maturity = age === null ? 1 : 1 + Math.min(age, 4) * 0.05;
  const breadth = 1 + Math.min(Math.max(p.chains.length - 1, 0), 9) * 0.01;
  const dampener = p.tvl_usd > 1_000_000_000 ? Math.max(0.55, Math.pow(1_000_000_000 / p.tvl_usd, 0.15)) : 1;
  return { momentum, maturity, breadth, dampener };
}

export function impliedValue(p: Protocol, multiple: number, f: Factors): number {
  const raw = p.tvl_usd * multiple * f.momentum * f.maturity * f.breadth * f.dampener;
  return Math.max(1, Math.round(raw));
}

// ---------------------------------------------------------------------------
// Farm plans. One playbook per category, written as five concrete steps with
// a cost and a duration each — never slogans. Slots (protocol name, its own
// chains, a size tier from its TVL, gas on its main chain) are filled from the
// snapshot row, so two protocols in one category still get plans that name
// their own chains and their own scale.
// ---------------------------------------------------------------------------

/** Typical per-transaction network cost on a chain, as a USD range. */
const GAS: Record<string, [number, number]> = {
  Ethereum: [4, 15],
  Base: [0.05, 0.3],
  Arbitrum: [0.1, 0.5],
  Optimism: [0.05, 0.3],
  Solana: [0.02, 0.1],
  Binance: [0.1, 0.4],
  Avalanche: [0.1, 0.6],
  Polygon: [0.01, 0.1],
};

function gasFor(chain: string): [number, number] {
  return GAS[chain] ?? [0.1, 1];
}

function money(x: number): string {
  if (x >= 100) return `$${Math.round(x)}`;
  if (x >= 10) return `$${x.toFixed(0)}`;
  return `$${x.toFixed(2)}`;
}

interface FarmCtx {
  name: string;
  chain: string;
  chain2: string | null;
  chainCount: number;
  tier: string;
  gasText: string;
}

function farmCtx(p: Protocol): FarmCtx {
  const chain = p.chains[0] ?? 'Ethereum';
  const [lo, hi] = gasFor(chain);
  const tier =
    p.tvl_usd >= 500_000_000
      ? 'a meaningful position starts near $5,000'
      : p.tvl_usd >= 50_000_000
        ? 'a meaningful position starts near $1,000–$5,000'
        : 'a meaningful position starts near $250–$1,000';
  return {
    name: p.name,
    chain,
    chain2: p.chains[1] ?? null,
    chainCount: p.chains.length,
    tier,
    gasText: `${money(lo)}–${money(hi)} per transaction on ${chain}`,
  };
}

/** The category’s core farming action (step 2 of every plan). */
const CORE: Record<string, (c: FarmCtx) => string> = {
  'Risk Curators': (c) =>
    `Deposit into one of ${c.name}'s curated vaults on ${c.chain} and leave the position untouched for at least 6 weeks; curators reward sticky capital, and vault share history is the record a points program would read. Gas runs ${c.gasText}.`,
  'Onchain Capital Allocator': (c) =>
    `Allocate into ${c.name}'s flagship vault on ${c.chain} and hold through two full allocation cycles (about 6–8 weeks); allocator tokens historically reward wallets that supplied capital early and stayed. Gas runs ${c.gasText}.`,
  Dexs: (c) =>
    `Trade on ${c.name} weekly and park a two-sided LP position in one of its core pairs on ${c.chain}; aim for roughly $500 of routed volume a week, the band where DEX points programs usually start counting. Gas runs ${c.gasText}.`,
  Lending: (c) =>
    `Supply a blue-chip collateral asset to ${c.name} on ${c.chain}, borrow 30–40% against it and repay on schedule; one careful loop, then hold the supply position for 6–8 weeks so the wallet ages in the protocol's books. Gas runs ${c.gasText}.`,
  RWA: (c) =>
    `Complete ${c.name}'s investor onboarding (KYC, about 1–2 hours) and buy the smallest lot of one tokenized real-world asset on ${c.chain}; RWA launches reward verified holders, and the minimum lot is usually enough to count. Platform fees apply per purchase.`,
  Yield: (c) =>
    `Deposit a stablecoin or ETH position into ${c.name}'s main vault on ${c.chain} and compound the yield weekly for 6–8 weeks; small, regular compounds are the activity trail yield protocols snapshot. Gas runs ${c.gasText}.`,
  'Yield Aggregator': (c) =>
    `Route a deposit through ${c.name}'s most-used vault on ${c.chain}, then let its auto-compounding run for 6–8 weeks, topping up once midway; aggregators count deposit age and balance history. Gas runs ${c.gasText}.`,
  Derivatives: (c) =>
    `Open small, hedged perpetual positions on ${c.name} (about $50 margin, low leverage) a few times a week and keep total volume steady rather than spiky; perps venues snapshot volume and open-interest history. Gas runs ${c.gasText}.`,
  CDP: (c) =>
    `Deposit collateral into a ${c.name} vault on ${c.chain}, mint its stablecoin at a conservative 150%+ ratio, hold the minted amount for 4 weeks, then repay and mint again once; CDP launches track minters who kept positions healthy. Gas runs ${c.gasText}.`,
  'Basis Trading': (c) =>
    `Deposit into ${c.name}'s basis vault on ${c.chain} and hold for a full funding cycle (6–8 weeks); basis products reward capital that stays through both positive and negative funding weeks. Gas runs ${c.gasText}.`,
  Chain: (c) =>
    `Bridge a working balance to ${c.name} and transact there weekly: swaps, one NFT mint, one lending deposit. New chains count active addresses and transaction weeks above almost everything else. Bridge plus gas runs about ${c.gasText}.`,
  'Staking Pool': (c) =>
    `Stake through ${c.name} on ${c.chain} and keep the stake bonded for at least two unbonding periods; staking launches read stake age, and churning resets it. Gas runs ${c.gasText}.`,
  Restaking: (c) =>
    `Restake a liquid staking token through ${c.name} on ${c.chain} and hold the position for 8 weeks; restaking points accrue per dollar per day, so time in position matters more than size spikes. Gas runs ${c.gasText}.`,
  'Liquidity Manager': (c) =>
    `Deposit into one of ${c.name}'s managed liquidity vaults on ${c.chain} and leave the position for 6–8 weeks; managed-LP products snapshot deposit age and average balance. Gas runs ${c.gasText}.`,
  'Leveraged Farming': (c) =>
    `Open one small leveraged farming position on ${c.name} at the lowest leverage tier on ${c.chain}, monitor it twice a week, and close and reopen once after a month to build a position history. Gas runs ${c.gasText}.`,
  'Prediction Market': (c) =>
    `Trade 2–3 liquid markets a week on ${c.name} with $10–25 positions and hold some to settlement; prediction venues reward settled volume and market-making presence, not one lucky bet. Fees are a small cut of each trade.`,
  Insurance: (c) =>
    `Buy one small cover policy through ${c.name} and stake a modest amount in its capital pool on ${c.chain}; insurance protocols count both sides, buyers and capital, when they launch. Gas runs ${c.gasText}.`,
  Payments: (c) =>
    `Route real payments through ${c.name} weekly — pay one bill or invoice a month through it — and keep a balance on the platform; payment launches count transacting users, not parked funds. Fees are the platform's standard per-payment cut.`,
  Indexes: (c) =>
    `Buy and hold one of ${c.name}'s index products on ${c.chain} for 8 weeks, adding a small amount monthly; index protocols snapshot holder age and balance. Gas runs ${c.gasText}.`,
  'Cross Chain Bridge': (c) =>
    `Bridge through ${c.name} twice a month between ${c.chain} and ${c.chain2 ?? 'a second chain it serves'}, varying the route; bridges count unique routes and repeat users. Each hop costs ${c.gasText} plus bridge fees.`,
};

const CORE_DEFAULT = (c: FarmCtx): string =>
  `Use ${c.name}'s core product on ${c.chain} with a real position — ${c.tier} — and keep it active for at least 6 weeks; launches in this category reward wallets with an aged, consistent usage record. Gas runs ${c.gasText}.`;

export function farmSteps(p: Protocol): string[] {
  const c = farmCtx(p);
  const core = (CORE[p.category ?? ''] ?? CORE_DEFAULT)(c);
  const steps = [
    `Open ${c.name} from its official site (reach it through its DefiLlama page, never a search ad), connect a fresh wallet on ${c.chain} and fund it with gas plus starter capital — ${c.tier}. Setup takes about 20 minutes; gas runs ${c.gasText}.`,
    core,
    `Repeat the core action on a weekly rhythm for 6–8 weeks, about 15 minutes a week, and keep a simple log of dates and amounts; consistency across weeks is the pattern points programs and snapshots are built to find. Running gas totals roughly ${money(gasFor(c.chain)[0] * 10)}–${money(gasFor(c.chain)[1] * 10)}.`,
    c.chain2 !== null
      ? `Extend to ${c.name}'s deployment on ${c.chain2} in week 3 or 4 with a second, smaller position; the protocol runs on ${c.chainCount} chains, and multi-chain users are the cohort a launch most wants to keep. Budget one bridge plus ${c.gasText}.`
      : `Deepen the main position once, in week 3 or 4, by about half its size, and turn on every in-product feature you qualify for (boosts, lock options, referrals); depth on one chain is what a single-chain protocol can measure. Gas runs ${c.gasText}.`,
    `Join ${c.name}'s official community and governance channels, vote or comment on the first proposal you are eligible for, and re-check this board monthly — about 30 minutes a month. If a points program or token announcement appears, your dated log is the proof of work.`,
  ];
  return steps;
}

/** Short cost/time summaries for the board’s farm column. */
export function farmMeta(p: Protocol): { cost: string; time: string } {
  const c = farmCtx(p);
  const [lo, hi] = gasFor(c.chain);
  const slow = p.category === 'RWA';
  return {
    cost: `≈ ${money(lo * 10)}–${money(hi * 10)} gas all-in`,
    time: slow ? '1–2 h setup, then 15 min/mo' : '~15 min/week, 6–8 weeks',
  };
}

// ---------------------------------------------------------------------------
// Launch odds. The board answers two questions, not one: what would a launch
// be worth (the implied value above), and how likely is a launch at all.
// The odds are a base rate, computed only from this snapshot: among the
// independent protocols in a category — the ones that already trade a token
// plus the candidates on this board — the share that has launched. Each
// category's raw share is shrunk toward the market-wide share with the same
// n/(n+4) weight the value model uses, so a category with two protocols
// cannot claim certainty the market does not support. Wrapped, staked and
// versioned products are excluded from the population on both sides: they
// are not independent protocols waiting on a launch of their own.
// ---------------------------------------------------------------------------

export interface OddsTable {
  global: number;
  byCategory: Map<string, { n: number; launched: number; rate: number; odds: number }>;
}

export function launchOddsTable(population: Protocol[]): OddsTable {
  const counts = new Map<string, { n: number; launched: number }>();
  let n = 0;
  let launched = 0;
  for (const p of population) {
    const key = p.category ?? 'Uncategorized';
    const c = counts.get(key) ?? { n: 0, launched: 0 };
    c.n += 1;
    n += 1;
    if (!recordsNoToken(p)) {
      c.launched += 1;
      launched += 1;
    }
    counts.set(key, c);
  }
  const global = n === 0 ? 0 : launched / n;
  const byCategory = new Map<string, { n: number; launched: number; rate: number; odds: number }>();
  for (const [key, c] of counts) {
    const rate = c.n === 0 ? global : c.launched / c.n;
    const w = c.n / (c.n + 4);
    byCategory.set(key, { n: c.n, launched: c.launched, rate, odds: w * rate + (1 - w) * global });
  }
  return { global, byCategory };
}

export function oddsFor(table: OddsTable, category: string | null): { n: number; launched: number; rate: number; odds: number } {
  const hit = table.byCategory.get(category ?? 'Uncategorized');
  return hit ?? { n: 0, launched: 0, rate: table.global, odds: table.global };
}

// ---------------------------------------------------------------------------
// Held-out evidence. Claims about a model are cheap; this board publishes
// its own out-of-sample scores, computed at run time from the snapshot it
// was fed. Protocols are split into two halves by a stable hash of the slug
// (FNV-1a, parity). Each half is then predicted by tables fitted on the
// other half only, so every scored protocol was held out from its own fit —
// the value multiples are graded on market caps they never saw, and the
// launch odds on launch outcomes they never saw (Brier score, against the
// naive strategy of quoting the market-wide rate for everyone).
// ---------------------------------------------------------------------------

function slugFold(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i += 1) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2;
}

const roundTo = (x: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

export function heldOutEvidence(protocols: Protocol[], candidateSlugs: Set<string>): Evidence {
  const traded = protocols.filter((p) => !recordsNoToken(p) && p.mcap_usd !== null && p.tvl_usd > 0);
  const errs: number[] = [];
  const pairs: { pred: number; actual: number }[] = [];
  for (const fold of [0, 1]) {
    const fit = categoryMultiples(traded.filter((p) => slugFold(p.slug) !== fold));
    for (const p of traded) {
      if (slugFold(p.slug) !== fold) continue;
      // Fitted exactly as the board fits, but graded only against protocols
      // carrying a market cap above zero — a recorded cap of $0 is a dead
      // token, and no value model can be scored against it.
      if (p.mcap_usd! <= 0) continue;
      const pred = p.tvl_usd * multipleFor(fit, p.category).multiple;
      errs.push(Math.abs(Math.log10(pred / p.mcap_usd!)));
      pairs.push({ pred, actual: p.mcap_usd! });
    }
  }
  errs.sort((a, b) => a - b);
  const med = errs.length === 0 ? 0 : median(errs);
  // Spearman rank correlation between the held-out predictions and the real
  // market caps: the board is a ranking, so it is graded as one.
  const spearman = (xs: { pred: number; actual: number }[]): number => {
    if (xs.length < 3) return 0;
    const ranks = (vals: number[]): number[] => {
      const order = vals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
      const out = new Array<number>(vals.length);
      let j = 0;
      while (j < order.length) {
        let k = j;
        while (k + 1 < order.length && order[k + 1]!.v === order[j]!.v) k += 1;
        const avg = (j + k) / 2 + 1;
        for (let t = j; t <= k; t += 1) out[order[t]!.i] = avg;
        j = k + 1;
      }
      return out;
    };
    const rp = ranks(xs.map((x) => x.pred));
    const ra = ranks(xs.map((x) => x.actual));
    const n = xs.length;
    const mp = rp.reduce((s, x) => s + x, 0) / n;
    const ma = ra.reduce((s, x) => s + x, 0) / n;
    let cov = 0;
    let vp = 0;
    let va = 0;
    for (let i = 0; i < n; i += 1) {
      cov += (rp[i]! - mp) * (ra[i]! - ma);
      vp += (rp[i]! - mp) ** 2;
      va += (ra[i]! - ma) ** 2;
    }
    return vp === 0 || va === 0 ? 0 : roundTo(cov / Math.sqrt(vp * va), 2);
  };
  const within = (cap: number): number =>
    errs.length === 0 ? 0 : roundTo((100 * errs.filter((e) => e <= Math.log10(cap)).length) / errs.length, 1);

  const population = protocols.filter((p) => !recordsNoToken(p) || candidateSlugs.has(p.slug));
  let brierModel = 0;
  let brierNaive = 0;
  let tested = 0;
  for (const fold of [0, 1]) {
    const fit = launchOddsTable(population.filter((p) => slugFold(p.slug) !== fold));
    for (const p of population) {
      if (slugFold(p.slug) !== fold) continue;
      const y = recordsNoToken(p) ? 0 : 1;
      const pm = oddsFor(fit, p.category).odds;
      brierModel += (pm - y) ** 2;
      brierNaive += (fit.global - y) ** 2;
      tested += 1;
    }
  }
  const bm = tested === 0 ? 0 : brierModel / tested;
  const bn = tested === 0 ? 0 : brierNaive / tested;
  return {
    value_tested: errs.length,
    value_median_factor: roundTo(10 ** med, 2),
    value_within_2x: within(2),
    value_within_3x: within(3),
    value_spearman: spearman(pairs),
    odds_tested: tested,
    odds_brier_model: roundTo(bm, 3),
    odds_brier_naive: roundTo(bn, 3),
    odds_brier_gain: bn === 0 ? 0 : roundTo((100 * (bn - bm)) / bn, 1),
  };
}

// ---------------------------------------------------------------------------
// Board assembly and self-check.
// ---------------------------------------------------------------------------

export function buildRadar(snapshot: Snapshot): { board: Row[]; radar: Radar } {
  const table = categoryMultiples(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  let tokenless = 0;
  let excluded = 0;
  const candidates: Protocol[] = [];
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p)) continue;
    tokenless += 1;
    if (exclusionReason(p) !== null) {
      excluded += 1;
      continue;
    }
    candidates.push(p);
  }
  const candidateSlugs = new Set(candidates.map((p) => p.slug));
  const oddsTable = launchOddsTable(
    snapshot.protocols.filter((p) => !recordsNoToken(p) || candidateSlugs.has(p.slug)),
  );
  const evidence = heldOutEvidence(snapshot.protocols, candidateSlugs);
  const scored: RadarRow[] = [];
  for (const p of candidates) {
    const mult = multipleFor(table, p.category);
    const age = ageYears(p, snapshot.as_of);
    const factors = factorsFor(p, age);
    const meta = farmMeta(p);
    const implied = impliedValue(p, mult.multiple, factors);
    const od = oddsFor(oddsTable, p.category);
    scored.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: farmSteps(p),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_years: age,
      watchlist: watch.has(p.slug),
      multiple: mult.multiple,
      multiple_n: mult.n,
      factors,
      odds: roundTo(od.odds, 3),
      odds_rate: roundTo(od.rate, 3),
      odds_n: od.n,
      odds_launched: od.launched,
      expected_value_usd: Math.round(implied * od.odds),
      farm_cost: meta.cost,
      farm_time: meta.time,
    });
  }
  scored.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.tvl_usd - a.tvl_usd ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  scored.forEach((r, i) => {
    r.rank = i + 1;
  });
  const board: Row[] = scored.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
  }));
  const multiples = [...table.byCategory.entries()]
    .map(([category, v]) => ({ category, n: v.n, multiple: v.multiple }))
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
  const radar: Radar = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    stats: {
      protocols: snapshot.protocols.length,
      tokenized: snapshot.protocols.length - tokenless,
      tokenless,
      excluded,
      candidates: scored.length,
      watchlist: snapshot.watchlist.length,
      total_implied_usd: scored.reduce((s, r) => s + r.implied_value_usd, 0),
      global_multiple: table.global,
      global_launch_rate: roundTo(oddsTable.global, 3),
    },
    multiples,
    evidence,
    rows: scored,
  };
  return { board, radar };
}

/** The gate’s board checks, restated: returns the first problem, or null. */
export function boardIssue(board: Row[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `rows ${board.length}, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const ranks = new Set<number>();
  for (const r of board) {
    if (!slugs.has(r.slug)) return `slug not in snapshot: ${r.slug}`;
    if (seen.has(r.slug)) return `slug twice: ${r.slug}`;
    seen.add(r.slug);
    if (r.name.trim() === '') return `empty name: ${r.slug}`;
    if (!Number.isInteger(r.rank) || r.rank < 1) return `bad rank: ${r.slug}`;
    if (ranks.has(r.rank)) return `rank twice: ${r.rank}`;
    ranks.add(r.rank);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 100_000_000_000_000) {
      return `bad implied value: ${r.slug}`;
    }
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `farm steps count: ${r.slug}`;
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `farm step length ${t.length}: ${r.slug}`;
    }
  }
  for (let i = 1; i <= board.length; i += 1) if (!ranks.has(i)) return `rank missing: ${i}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i += 1) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) {
      return `implied value rises at rank ${byRank[i]!.rank}`;
    }
  }
  if (board.length > 1 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) {
    return 'all implied values equal';
  }
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `watchlist slug missing: ${slug}`;
  return null;
}

/** The dashboard’s data file: the whole radar as one script. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
