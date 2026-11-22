// Token Radar — valuation model, board builder and farm-plan generator.
//
// One snapshot in, one ranked board out. Every figure on the board is derived
// from the snapshot's own numbers; no protocol name is ever special-cased.
//
// THE VALUE MODEL (radar-2)
// -------------------------
// implied_value = TVL x category_multiple x growth_factor x maturity_factor
//                 x chain_factor, rounded to whole dollars.
//
// 1. category_multiple — CALIBRATED FROM THE SNAPSHOT ITSELF. For every
//    category, take the tokenized protocols in that category (mcap_usd > 0),
//    compute mcap / TVL for each, winsorize each ratio into [0.02, 2.50] so a
//    single absurd print (a 400x prediction-market outlier, a 19x locker)
//    cannot poison a whole category, and take the median. A category needs at
//    least MIN_PEERS (5) tokenized peers for its own median; with fewer than
//    5, the category's own median is NOT used at all — the model falls back
//    to the global winsorized median across all tokenized protocols. A
//    category priced by one or two lucky peers is how a board ends up
//    claiming a curator is worth 2.9x its TVL; the minimum sample exists to
//    make that impossible.
//    The final multiple is clamped into [0.05, 1.50]: a pre-token launch is
//    not credibly worth more than 1.5x the TVL already locked in it, and no
//    live category in this snapshot medians below 0.05.
// 2. growth_factor = 1 + clamp(change_7d, -40, +80) / 100 x 0.60.
//    A hot week lifts value, a bleeding week cuts it, but one week of TVL
//    flow can never more than ~1.5x or less than ~0.76x a valuation.
//    A missing change_7d counts as 0 (neutral), never as growth.
// 3. maturity_factor = 0.78 + min(age_days, 1825) / 1825 x 0.44, so a
//    protocol tracked for five years with no token scores 1.22 and a
//    brand-new one 0.78. Survival with no token is evidence; it is not a
//    promise. Unknown listing dates use a 400-day proxy (factor ~0.88).
//    Future listing dates (the snapshot contains a few) clamp to age 0.
// 4. chain_factor = 1 + min(chains - 1, 5) x 0.03 (1.00 to 1.15). Each extra
//    live chain is distribution a launch inherits on day one; capped so a
//    23-chain curator cannot win on chain count alone.
//
// Every board row carries the full breakdown (multiple, peer count, each
// factor, base value) so the dashboard can show the arithmetic per protocol
// and anyone can recompute a row from the snapshot by hand.
//
// THE BOARD
// ---------
// Ranked rows are strictly pre-token protocols: mcap, gecko_id and symbol all
// null (the snapshot records no token). The board always contains every
// watchlist slug, plus the highest-implied pre-token protocols below the
// floor, for BOARD_ROWS rows in total. Tokenized protocols are never ranked;
// they are returned separately as an unranked reference set with their real
// market caps, which is also the set the multiples were calibrated from.

export interface SnapshotProtocol {
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
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-2';
export const BOARD_ROWS = 300;
export const LIVE_ROWS = 36;

const RATIO_FLOOR = 0.02;
const RATIO_CAP = 2.5;
const MULT_FLOOR = 0.05;
const MULT_CAP = 1.5;
const MIN_PEERS = 5;
const GROWTH_FLOOR = -40;
const GROWTH_CAP = 80;
const GROWTH_WEIGHT = 0.6;
const MATURITY_BASE = 0.78;
const MATURITY_SPAN = 0.44;
const MATURITY_DAYS = 1825;
const UNKNOWN_AGE_DAYS = 400;
const CHAIN_STEP = 0.03;
const CHAIN_MAX_EXTRA = 5;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** One category's calibrated multiple, plus how it was derived. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  peers: number;
  source: 'category' | 'global';
}

/** The calibration table: one entry per category that appears on the board. */
/** If a snapshot carried no tokenized protocol at all, calibration has no
 *  evidence; this documented constant (near this snapshot's real global
 *  median) is used rather than letting a median of zero values become NaN. */
const NO_PEERS_FALLBACK = 0.2;

export function calibrateMultiples(protocols: SnapshotProtocol[]): Map<string, CategoryMultiple> {
  const tokenized = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const globalMedian = tokenized.length > 0 ? median(tokenized.map((p) => clamp(p.mcap_usd! / p.tvl_usd, RATIO_FLOOR, RATIO_CAP))) : NO_PEERS_FALLBACK;
  const byCategory = new Map<string, number[]>();
  for (const p of tokenized) {
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(clamp(p.mcap_usd! / p.tvl_usd, RATIO_FLOOR, RATIO_CAP));
    byCategory.set(key, list);
  }
  const out = new Map<string, CategoryMultiple>();
  const categories = new Set(protocols.map((p) => p.category ?? 'Uncategorised'));
  for (const category of categories) {
    const ratios = byCategory.get(category) ?? [];
    let multiple: number;
    let source: CategoryMultiple['source'];
    if (ratios.length >= MIN_PEERS) {
      multiple = median(ratios);
      source = 'category';
    } else {
      // Minimum-sample rule: fewer than MIN_PEERS tokenized peers means the
      // category's own median is not evidence, so it is not used — not even
      // blended. The global winsorized median prices the category instead.
      multiple = globalMedian;
      source = 'global';
    }
    out.set(category, { category, multiple: round4(clamp(multiple, MULT_FLOOR, MULT_CAP)), peers: ratios.length, source });
  }
  return out;
}

/** The full scoring breakdown for one protocol. */
export interface Breakdown {
  implied: number;
  base_value_usd: number;
  category_multiple: number;
  multiple_peers: number;
  multiple_source: string;
  growth_pct: number;
  growth_factor: number;
  maturity_factor: number;
  chain_factor: number;
  age_days: number | null;
}

export function scoreProtocol(p: SnapshotProtocol, asOf: string, multiples: Map<string, CategoryMultiple>): Breakdown {
  const entry = multiples.get(p.category ?? 'Uncategorised')!;
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(p.change_7d ?? 0, GROWTH_FLOOR, GROWTH_CAP);
  const growthFactor = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturityFactor = MATURITY_BASE + (Math.min(ageForModel, MATURITY_DAYS) / MATURITY_DAYS) * MATURITY_SPAN;
  const chainFactor = 1 + Math.min(Math.max(p.chains.length - 1, 0), CHAIN_MAX_EXTRA) * CHAIN_STEP;
  const base = p.tvl_usd * entry.multiple;
  // The implied value is computed from the ROUNDED factors, exactly as they
  // are stored on the row, so the dashboard can recompute the same integer
  // from the row's own breakdown and prove the page and board.json agree.
  const implied = Math.max(1, Math.round(base * round4(growthFactor) * round4(maturityFactor) * round4(chainFactor)));
  return {
    implied,
    base_value_usd: Math.round(base),
    category_multiple: entry.multiple,
    multiple_peers: entry.peers,
    multiple_source: entry.source,
    growth_pct: growthPct,
    growth_factor: round4(growthFactor),
    maturity_factor: round4(maturityFactor),
    chain_factor: round4(chainFactor),
    age_days: age,
  };
}

/** Records no token at all: the only protocols the ranked board may carry. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
// Categories that are products of assets that already trade, not launch
// candidates in their own right — the same reasoning the snapshot's own
// watchlist rule uses. WBTC, USDT0 and the canonical bridges record no token
// of their own, but ranking them as future launches would be nonsense: their
// value is the wrapped asset's value, already priced. Watchlist rows are
// always included regardless; this filter shapes only the early radar.
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Pre-token and a plausible launch candidate in its own right. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !PRODUCT_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

// ---------------------------------------------------------------- farm plans
//
// Costs are chain-realistic on purpose: an Ethereum L1 transaction is priced
// at roughly $12 of gas, an L2 transaction at $0.10-$0.40, a Solana
// transaction at about $0.02. A plan that quoted L2 prices for an L1-only
// protocol (or the reverse) would mislead the farmer about the real budget,
// so every cost below is computed from the protocol's own primary chain.

export interface ChainProfile {
  label: string;
  gas_usd: number;
  fund_usd: number;
  fund_time: string;
}

export function chainProfile(chain: string): ChainProfile {
  switch (chain) {
    case 'Ethereum':
      return { label: 'Ethereum L1', gas_usd: 12, fund_usd: 12, fund_time: '10 minutes' };
    case 'Solana':
      return { label: 'Solana', gas_usd: 0.02, fund_usd: 0.02, fund_time: '2 minutes' };
    case 'Bitcoin':
      return { label: 'Bitcoin', gas_usd: 1.5, fund_usd: 1.5, fund_time: '30-60 minutes for one confirmation' };
    case 'Base':
    case 'Arbitrum':
    case 'Optimism':
    case 'Scroll':
    case 'Linea':
    case 'Unichain':
    case 'Ink':
    case 'Mode':
    case 'ZkSync Era':
      return { label: `${chain} (Ethereum L2)`, gas_usd: 0.25, fund_usd: 3, fund_time: '10 minutes via the official bridge, ~7 days to withdraw back to L1' };
    case 'Binance':
      return { label: 'BNB Chain', gas_usd: 0.2, fund_usd: 0.2, fund_time: '5 minutes' };
    case 'Polygon':
      return { label: 'Polygon', gas_usd: 0.02, fund_usd: 1, fund_time: '10 minutes via the official bridge' };
    case 'Avalanche':
      return { label: 'Avalanche C-Chain', gas_usd: 0.25, fund_usd: 0.25, fund_time: '5 minutes' };
    case 'Sui':
      return { label: 'Sui', gas_usd: 0.01, fund_usd: 0.5, fund_time: '10 minutes via Wormhole or an exchange withdrawal' };
    case 'Tron':
      return { label: 'Tron', gas_usd: 0.3, fund_usd: 0.3, fund_time: '5 minutes' };
    case 'Hyperliquid L1':
      return { label: 'Hyperliquid L1', gas_usd: 0.05, fund_usd: 1, fund_time: '5 minutes via the Arbitrum bridge' };
    default:
      return { label: chain, gas_usd: 0.5, fund_usd: 1, fund_time: '15 minutes via the chain official bridge or an exchange withdrawal' };
  }
}

const money = (n: number): string => (n < 1 ? `$${n.toFixed(2)}` : n < 10 ? `$${n.toFixed(2).replace(/\.?0+$/, '')}` : `$${Math.round(n)}`);

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 500;
  if (p.tvl_usd >= 250_000_000) return 250;
  if (p.tvl_usd >= 50_000_000) return 150;
  if (p.tvl_usd >= 10_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 730) return 45;
  return 30;
}

interface CategoryActions {
  core: string;
  second: string;
  weekly: string;
}

function actionsFor(p: SnapshotProtocol, capital: number, chainLabel: string): CategoryActions {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  const cap = `$${capital}`;
  if (c.includes('dex'))
    return {
      core: `Swap at least ${cap} of volume through ${n} on ${chainLabel}, splitting it into 4 swaps of about $${Math.round(capital / 4)} across two different pairs so the activity looks like real use, not one wash trade.`,
      second: `Add ${cap} of two-sided liquidity to ${n}'s highest-TVL pool and leave the LP position open; check the pool impermanent-loss figure once a week.`,
      weekly: `Make 2 swaps of $25 or more and confirm the LP position is still in range and earning fees.`,
    };
  if (c.includes('lend') || c.includes('cdp'))
    return {
      core: `Supply ${cap} of USDC or the chain's main stablecoin as collateral in ${n} on ${chainLabel} and keep the supplied balance above ${cap} for the whole hold period.`,
      second: `Borrow about 30% of the supplied value (roughly $${Math.round(capital * 0.3)}) against the collateral, hold it for at least 7 days, then repay in full; keep the health factor above 2.0 at all times.`,
      weekly: `Check the health factor and the supply balance once a week; top up collateral if the health factor falls below 2.0.`,
    };
  if (c.includes('derivative') || c.includes('perpetual'))
    return {
      core: `Deposit ${cap} of USDC as margin on ${n} (${chainLabel}) and open one small position of about $${Math.round(capital / 2)} notional at 2x leverage or less, hedged or delta-neutral where the venue allows it.`,
      second: `Close and reopen a position once so the account records completed trades, not just a deposit; keep total fees paid under 2% of the margin.`,
      weekly: `Place 1-2 small trades a week to build a real volume history; never chase volume with leverage above 3x.`,
    };
  if (c.includes('bridge') || c.includes('cross chain'))
    return {
      core: `Bridge ${cap} of USDC from Ethereum or an L2 to ${chainLabel} through ${n}, then use the bridged funds in a destination-chain app instead of bridging straight back.`,
      second: `Bridge a second, different asset (for example ETH or the chain gas token) of about $${Math.round(capital / 2)} on a different day, so the wallet shows two genuine routes.`,
      weekly: `Make one small bridge transfer of $25 or more each week, alternating direction, and keep a record of each route used.`,
    };
  if (c.includes('staking') || c.includes('restak') || c.includes('collateral'))
    return {
      core: `Stake ${cap} worth of the chain's staking asset through ${n} on ${chainLabel} and keep the staking receipt token in the same wallet for the whole hold period.`,
      second: `Claim or compound the staking rewards once after at least 14 days, so the wallet records a full stake-claim cycle, and note the unbonding period before you start.`,
      weekly: `Check the position and the current unbonding queue once a week; do not start unstaking before the hold period ends.`,
    };
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield'))
    return {
      core: `Deposit ${cap} of USDC into the largest ${n} vault on ${chainLabel} and keep the vault shares untouched for the whole hold period.`,
      second: `After 14 days, deposit a further $${Math.round(capital / 2)} into a second ${n} vault with a different strategy, so the wallet holds two distinct curator positions.`,
      weekly: `Check both vault balances and the vault APY once a week; move nothing unless a vault reports a loss or a depeg.`,
    };
  if (c.includes('rwa') || c.includes('stable'))
    return {
      core: `Mint or buy ${cap} of ${n}'s yield-bearing asset on ${chainLabel} through its own app and hold the asset in the farming wallet for the whole period.`,
      second: `Complete the protocol's own onboarding or KYC step if it offers one, and make one small second purchase of about $${Math.round(capital / 4)} at least two weeks after the first.`,
      weekly: `Check the asset price against its stated backing once a week and record any discount wider than 1%.`,
    };
  if (c.includes('basis'))
    return {
      core: `Deposit ${cap} of USDC into ${n} on ${chainLabel} to open its basis position and keep the position open for the whole hold period.`,
      second: `Add $${Math.round(capital / 2)} more after at least 14 days in a separate transaction, so the wallet shows two funding rounds rather than one lump.`,
      weekly: `Check the position value and the reported funding yield once a week; withdraw only if the position reports a loss two weeks running.`,
    };
  if (c.includes('chain') || c.includes('payment'))
    return {
      core: `Fund a wallet on ${chainLabel} and route ${cap} of real activity through ${n}: make at least 5 genuine transactions (transfers, payments or app interactions) across at least 3 different days.`,
      second: `Use one native app on the chain each week (a DEX, a lending market or the chain's own service) so the wallet has contract interactions, not just transfers.`,
      weekly: `Make 3-5 transactions a week on different days; steady organic activity counts for more than one large burst.`,
    };
  if (c.includes('insurance'))
    return {
      core: `Buy ${cap} of cover from ${n} on ${chainLabel} for a position you actually hold, and keep the policy active for at least 30 days.`,
      second: `Underwrite a small pool position of about $${Math.round(capital / 2)} if ${n} offers capacity pools, and keep it through one full epoch.`,
      weekly: `Check the policy and pool status once a week and renew the cover before it lapses.`,
    };
  return {
    core: `Deposit ${cap} of USDC into ${n} on ${chainLabel} through its own app and keep the position open for the whole hold period.`,
    second: `Make one second, different interaction (a second deposit, a claim, a vote or a settings change) of about $${Math.round(capital / 4)} at least two weeks after the first deposit.`,
    weekly: `Repeat the protocol's core action once a week at small size and record each transaction in the farm log.`,
  };
}

/** A stable per-protocol variant seed: the same slug always picks the same
 *  plan shape, so two runs of the program write identical bytes, while
 *  different protocols get different shapes, orders and phrasings. */
function slugSeed(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 9973;
  return h;
}

/** Categories whose live products run points or epoch programmes a farmer
 *  should explicitly track; the plan adds a dedicated step for them. */
function hasPointsCulture(p: SnapshotProtocol): boolean {
  const c = (p.category ?? '').toLowerCase();
  return c.includes('dex') || c.includes('lend') || c.includes('derivative') || c.includes('perpetual') || c.includes('restak') || c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis');
}

/**
 * A protocol's farm plan, generated from its own category, primary chain,
 * TVL band and age. The plan's SHAPE varies by protocol (a slug-seeded
 * variant picks the step order, the phrasing bank and whether a dedicated
 * points/epoch step is included, for 6-8 steps), because 200 identical
 * skeletons would read as a template, not as 200 plans. Every step carries
 * a cost in dollars computed from the primary chain's gas price and a time
 * commitment, and the category steps describe that category's real
 * mechanics: LP provision, borrow loops, perp volume, vault shares, basis
 * funding, bridge routes.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const primary = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const profile = chainProfile(primary);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const acts = actionsFor(p, capital, profile.label);
  const g = profile.gas_usd;
  const setupGas = Math.max(0.02, g * 2);
  const weeklyGas = Math.max(0.02, g * 2);
  const variant = slugSeed(p.slug) % 3;

  const setup = [
    `Set up one fresh wallet for ${p.name} only, back up its seed phrase offline, and label it with the protocol name and start date. Cost: about ${money(setupGas)} of gas for the first two transactions on ${profile.label}. Time: 10 minutes, once.`,
    `Start with a clean wallet that has never farmed another protocol, so ${p.name} activity is attributable to one address; store the seed phrase offline. Cost: about ${money(setupGas)} of gas to activate it on ${profile.label}. Time: 10 minutes, once.`,
    `Create a dedicated farming wallet for ${p.name} and write its address, the start date and the target hold of ${hold} days in a farm log before spending anything. Cost: about ${money(setupGas)} of gas for its first transactions on ${profile.label}. Time: 10 minutes, once.`,
  ][variant]!;
  const fund = [
    `Fund the wallet with ${money(capital + Math.max(5, g * 4))} of working funds on ${profile.label}: ${money(capital)} of farm capital plus a gas buffer of about ${money(Math.max(5, g * 4))}. Cost: about ${money(profile.fund_usd)} in bridge or withdrawal fees. Time: ${profile.fund_time}.`,
    `Move ${money(capital)} of farm capital plus a ${money(Math.max(5, g * 4))} gas buffer onto ${profile.label} before touching the app, so a stuck bridge never leaves a half-open position. Cost: about ${money(profile.fund_usd)} in bridge or withdrawal fees. Time: ${profile.fund_time}.`,
    `Get funds in place first: ${money(capital)} to deploy and about ${money(Math.max(5, g * 4))} reserved for gas on ${profile.label}. Cost: about ${money(profile.fund_usd)} in bridge or withdrawal fees. Time: ${profile.fund_time}.`,
  ][variant]!;
  const core = `${acts.core} Cost: ${money(capital)} of capital plus about ${money(Math.max(0.02, g * 3))} of gas for the approval and deposit transactions. Time: 20 minutes to set up.`;
  const second = `${acts.second} Cost: about ${money(Math.max(0.02, g * 2))} of gas on ${profile.label}. Time: 15 minutes.`;
  const weekly = `${acts.weekly} Cost: about ${money(weeklyGas)} of gas per week on ${profile.label}. Time: 15 minutes per week.`;
  const points = `Open ${p.name}'s own points, seasons or rewards page if it runs one, screenshot the wallet's standing, and repeat that check every epoch boundary so a missed claim window never costs the whole farm. Cost: no fee to check; about ${money(Math.max(0.02, g))} of gas only if a claim transaction is needed. Time: 10 minutes per epoch.`;
  const holdStep = [
    `Hold the position for at least ${hold} days so the activity spans several weekly snapshots, and keep a farm log with the wallet address, every transaction hash and the running total spent. Cost: the ${money(capital)} stays deployed; expected total gas over the hold is about ${money(weeklyGas * Math.ceil(hold / 7) + setupGas)}. Time: ${hold} days, checked weekly.`,
    `Leave the ${money(capital)} deployed for a minimum of ${hold} days: snapshots and points programmes reward duration, and an early exit usually forfeits the season. Log every transaction hash as you go. Cost: expected total gas over the hold is about ${money(weeklyGas * Math.ceil(hold / 7) + setupGas)}. Time: ${hold} days, checked weekly.`,
    `Commit to ${hold} days before entering: that is the window this plan's weekly actions are sized for, and it spans enough snapshots for the activity to count as sustained use. Cost: the ${money(capital)} stays in the position; gas over the whole hold should total about ${money(weeklyGas * Math.ceil(hold / 7) + setupGas)}. Time: ${hold} days.`,
  ][variant]!;
  const exit = [
    `Exit or claim only through the link on ${p.name}'s own official page, and never pay a third party to claim for you. Cost: about ${money(Math.max(0.02, g * 2))} of gas to withdraw or claim on ${profile.label}. Time: 20 minutes, at the end of the hold.`,
    `When the hold ends, withdraw and claim only from ${p.name}'s official page — bookmark it on day one so a search-ad clone cannot intercept the claim. Cost: about ${money(Math.max(0.02, g * 2))} of gas on ${profile.label}. Time: 20 minutes.`,
    `Close out deliberately: repay or unwind in the reverse order you entered, then claim from the official ${p.name} page only. Cost: about ${money(Math.max(0.02, g * 2))} of gas on ${profile.label}. Time: 20 minutes, at the end of the hold.`,
  ][variant]!;

  let steps: string[];
  if (variant === 0) {
    steps = [setup, fund, core, second, weekly, holdStep, exit];
  } else if (variant === 1) {
    steps = [fund, setup, core, weekly, second, holdStep, exit];
    if (hasPointsCulture(p)) steps.splice(4, 0, points);
  } else {
    steps = [setup, fund, core, second, holdStep, weekly, exit];
    if (hasPointsCulture(p)) steps.splice(5, 0, points);
  }
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ---------------------------------------------------------------- the board

export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_value_usd: number;
    category_multiple: number;
    multiple_peers: number;
    multiple_source: string;
    growth_pct: number;
    growth_factor: number;
    maturity_factor: number;
    chain_factor: number;
  };
  farm_steps: string[];
  farm_capital_usd: number;
  farm_chain: string;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
  symbol: string | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_protocols: number;
  multiples: CategoryMultiple[];
  rows: BoardRow[];
  live: LiveRow[];
}

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const multiples = calibrateMultiples(snapshot.protocols);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const scored = snapshot.protocols
    .filter((p) => isRankable(p) && !chosen.has(p.slug))
    .map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, multiples) }))
    .sort((a, b) => b.score.implied - a.score.implied || (a.p.slug < b.p.slug ? -1 : 1));
  for (const { p } of scored) {
    if (chosen.size >= BOARD_ROWS) break;
    chosen.set(p.slug, p);
  }
  const rows = [...chosen.values()].map((p) => {
    const b = scoreProtocol(p, snapshot.as_of, multiples);
    return { p, b };
  });
  rows.sort((a, b) => b.b.implied - a.b.implied || (a.p.slug < b.p.slug ? -1 : 1));
  return rows.map(({ p, b }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token' as const,
    on_watchlist: watch.has(p.slug),
    age_days: b.age_days,
    implied_value_usd: b.implied,
    model: {
      base_value_usd: b.base_value_usd,
      category_multiple: b.category_multiple,
      multiple_peers: b.multiple_peers,
      multiple_source: b.multiple_source,
      growth_pct: b.growth_pct,
      growth_factor: b.growth_factor,
      maturity_factor: b.maturity_factor,
      chain_factor: b.chain_factor,
    },
    farm_steps: farmSteps(p, b.age_days),
    farm_capital_usd: capitalFor(p),
    farm_chain: p.chains.length > 0 ? p.chains[0]! : 'Ethereum',
  }));
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      symbol: p.symbol,
    }));
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const multiples = calibrateMultiples(snapshot.protocols);
  const usedCategories = new Set(board.map((r) => r.category ?? 'Uncategorised'));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    total_protocols: snapshot.protocols.length,
    multiples: [...multiples.values()]
      .filter((m) => usedCategories.has(m.category))
      .sort((a, b) => b.multiple - a.multiple),
    rows: board,
    live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, outside 100-4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'all rows share one implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
