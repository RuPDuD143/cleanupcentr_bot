// bot-runner.mjs
// Headless version of farm.html — signs with a scoped "bot" permission key
// instead of a MyCloudWallet browser popup. Run via GitHub Actions cron.
//
// Required env vars:
//   WAX_ACCOUNT      e.g. "hzenu.c.wam"
//   WAX_BOT_KEY      the PRIVATE key for the scoped "bot" permission (never the active/owner key)
//
// npm deps: @wharfkit/session @wharfkit/antelope @wharfkit/wallet-plugin-privatekey

import { Session } from "@wharfkit/session";
import { WalletPluginPrivateKey } from "@wharfkit/wallet-plugin-privatekey";
import { UInt64 } from "@wharfkit/antelope";

// ─── Constants (copied from farm.html) ────────────────────────────────────
const CHAIN = {
  id: "1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4",
  url: "https://wax.greymass.com"
};
const PROXY        = "https://cleanupcentr.rrlworlds1434.workers.dev/?url=";
const API_BASE     = "https://maestrobeatz.servegame.com";
const FARM_ID      = "1099958357919";

const CONTRACT     = "rhythmfarmer";
const CINDER_CTR   = "cleanuptoken";
const ATOMIC_CTR   = "atomicassets";
const MAESTRO_CTR  = "maestrobeatz";

const HOURS_8      = 8 * 60 * 60 * 1000;
const FEE_RECIPIENT     = "hzenu.c.wam";
const RUCOIN_CTR        = "rupdud143143";
const RUCOIN_SYMBOL     = "RUCOIN";
const RUCOIN_DECIMALS   = 4;
const RUCOIN_TOKEN_ID   = "rucoin-rupdud143143";
const FEE_PER_POINT_USD = 0.001;
const TASK_FEE_ACTIONS  = new Set(["water", "harvest", "plant", "startmach", "claimmach", "claimseedrwd"]);
const MACHINE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MACHINES_ENABLED = false; // TEMP: machine claim/reload disabled — flip back to true to re-enable
const ENERGY_COST = { water: 2, harvest: 2, plant: 2, claimmach: 100 };
const CINDER_PER_ENERGY = 2;
const UINT64_FIELDS = new Set(["plot_asset_id", "slot_index", "machine_id", "seed_batch_id", "recipe_id", "batch_size", "seed_tpl_id"]);

// ─── Crafting mechanics (ported from farm.html) ───────────────────────────
const PACK_BLEND_ID       = 1;
const TOMATOE_PACK_MAIN   = 1800000;
const TOMATOE_PACK_FEE    = 420000;
const TOMATOE_PACK_COST   = TOMATOE_PACK_MAIN + TOMATOE_PACK_FEE + 1000000; // 3,220,000

const BIG_PACK_BLEND_ID   = 2;
const BIG_PACK_MAIN       = 13400000;
const BIG_PACK_FEE        = 3000000;
const BIG_PACK_COST       = BIG_PACK_MAIN + BIG_PACK_FEE + 1000000; // 17,400,000

const SEED_STOCK_THRESHOLD = 20;

const COMPOST_TPL_ID      = 904726;
const COMPOST_BLEND_ID    = 4;
const COMPOST_BLEND_BATCH = 10;
const COMPOST_BLEND_MIN   = 35;
const COMPOST_BLEND_TOMATOE_QTY = "71000.00000000 TOMATOE";
const COMPOST_BLEND_BANANAZ_QTY = "7100.00000000 BANANAZ";

const ECO_COMPOST_TPL_ID  = 900863;
const ECO_BLEND_ID        = 2;
const ECO_BLEND_BATCH     = 3;
const ECO_BLEND_MIN       = 3;
const ECO_BLEND_TOMATOE_QTY = "323000.00000000 TOMATOE";

const WAX_ACCOUNT = process.env.WAX_ACCOUNT;
const WAX_BOT_KEY = process.env.WAX_BOT_KEY;
if (!WAX_ACCOUNT || !WAX_BOT_KEY) {
  console.error("Missing WAX_ACCOUNT or WAX_BOT_KEY env vars.");
  process.exit(1);
}

// ─── Session (headless, scoped permission) ────────────────────────────────
const session = new Session({
  chain: CHAIN,
  actor: WAX_ACCOUNT,
  permission: "bot", // must match the permission created via bot-permission-setup.html
  walletPlugin: new WalletPluginPrivateKey(WAX_BOT_KEY),
});

const actor = () => WAX_ACCOUNT;
const perm  = () => ({ actor: actor(), permission: "bot" });

// ─── API helper — routed through the same proxy worker as farm.html,
// in case the game server only accepts traffic coming from that worker ────
async function apiFetch(path) {
  const url = PROXY + API_BASE + path;
  const res = await fetch(url, {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://rupdud143.github.io"
    }
  });
  const text = await res.text();
  const match = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) throw new Error("No JSON found in response for: " + path);
  return JSON.parse(match[0]);
}

async function fetchBalances() {
  const tokenDefs = [
    { key: "tomatoe", code: "maestrobeatz", symbol: "TOMATOE" },
    { key: "bananaz", code: "maestrobeatz", symbol: "BANANAZ" },
    { key: "cinder",  code: "cleanuptoken", symbol: "CINDER"  },
    { key: "rucoin",  code: RUCOIN_CTR,     symbol: RUCOIN_SYMBOL },
  ];
  const balances = { tomatoe: 0, bananaz: 0, cinder: 0, rucoin: 0 };
  await Promise.all(tokenDefs.map(async t => {
    try {
      const res = await fetch("https://wax.greymass.com/v1/chain/get_currency_balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: t.code, account: actor(), symbol: t.symbol })
      });
      const data = await res.json();
      const raw = data.length > 0 ? data[0] : `0 ${t.symbol}`;
      balances[t.key] = parseFloat(raw.split(" ")[0]) || 0;
    } catch { /* leave at 0 */ }
  }));
  return balances;
}

async function fetchRucoinPrice() {
  try {
    const res  = await fetch(`https://wax.alcor.exchange/api/v2/tokens/${RUCOIN_TOKEN_ID}`);
    const data = await res.json();
    const price = (typeof data.safe_usd_price === "number" && data.safe_usd_price > 0) ? data.safe_usd_price : data.usd_price;
    return (typeof price === "number" && price > 0) ? price : null;
  } catch { return null; }
}

function buildSeedArray(playerStatus) {
  const batches = playerStatus?.seeds?.batches || [];
  const expanded = [];
  batches.forEach(b => {
    const qty = Number(b.qty) || 1;
    for (let i = 0; i < qty; i++) {
      expanded.push({ seed_asset_id: b.seed_asset_id, seed_tpl_id: b.seed_tpl_id, level: b.seed_tpl_id, fromBag: false });
    }
  });
  // Seed tpl priority: 3 > 1 > 2 (not numeric order). Unknown tpl ids sort last.
  const SEED_TPL_PRIORITY = [3, 1, 2];
  const rank = tpl => {
    const i = SEED_TPL_PRIORITY.indexOf(tpl);
    return i === -1 ? SEED_TPL_PRIORITY.length : i;
  };
  expanded.sort((a, b) => rank(a.level) - rank(b.level));
  return expanded;
}

function isMachineClaimable(machine) {
  if (!machine) return false;
  if (!machine.pending) return false;
  const lastStart = new Date((machine.last_start || machine.pending?.created_at) + "Z").getTime();
  if (isNaN(lastStart)) return false;
  return (Date.now() - lastStart) >= MACHINE_COOLDOWN_MS;
}

function isActionFeeable(action) {
  if (!action) return false;
  const { account, name, data } = action;
  if (account === CONTRACT && TASK_FEE_ACTIONS.has(name)) return true;
  if (account === CINDER_CTR && name === "transfer" && data?.memo === "poweruser") return true;
  if (account === ATOMIC_CTR && name === "transfer") {
    const memo = data?.memo || "";
    if (memo.includes("deposit:compost") || memo.includes("open:seedpack")) return true;
    if (memo === `BLEND:${PACK_BLEND_ID}`) return true; // pack open — 1 pt per pack
    if (memo === `stake:plot:${FARM_ID}`) return true;  // plot stake — 1 pt per plot
  }
  return false;
}

function calculateFeePoints(actions) {
  let points = 0;
  const machineLoadIds = new Set();
  const compostBlendGroups = new Set();
  const ecoBlendGroups = new Set();
  let buyPackCounted = false;
  actions.forEach(a => {
    if (!a || a._label?.startsWith("💸 Fee")) return;
    if (isActionFeeable(a)) { points += 1; return; }
    if (a.account === MAESTRO_CTR && a.name === "transfer") {
      const mid = a.data?.memo?.match(/recipe:machine:(\d+)/)?.[1];
      if (mid) { machineLoadIds.add(mid); return; }
      if (a._label?.startsWith("🛒")) { buyPackCounted = true; return; }
    }
    const compostMatch = a._label?.match(/^🧪 Compost blend #(\d+)/);
    if (compostMatch) { compostBlendGroups.add(compostMatch[1]); return; }
    const ecoMatch = a._label?.match(/^🧬 Eco compost blend #(\d+)/);
    if (ecoMatch) { ecoBlendGroups.add(ecoMatch[1]); return; }
  });
  points += machineLoadIds.size;
  points += compostBlendGroups.size;
  points += ecoBlendGroups.size;
  if (buyPackCounted) points += 1;
  return points;
}

function buildFeeAction(points, price) {
  if (!points || points <= 0) return null;
  if (!price || price <= 0) return null;
  if (actor() === FEE_RECIPIENT) return null; // exempt for your own account
  const usdFee = points * FEE_PER_POINT_USD;
  const qty = (usdFee / price).toFixed(RUCOIN_DECIMALS);
  return {
    account: RUCOIN_CTR, name: "transfer",
    data: { from: actor(), to: FEE_RECIPIENT, quantity: `${qty} ${RUCOIN_SYMBOL}`, memo: `fee:${points}pt` },
    _label: `💸 Fee — ${points} pt`
  };
}

// ─── Plant helper (in-game seeds/compost only — bag NFTs need image lookups
// that were browser-only; if you rely on bag seeds/compost regularly, tell
// me and I'll port the /bag/{actor} handling in too) ───────────────────────
let seedArray = [];
let bagSeedArray = [];
let bagCompostArray = [];
let bagPackArray = [];
let bagPlotArray = [];
let compostBalance = 0;
let seedIdx = 0, _bagCompostIdx = 0, _compostUsed = 0;
function resetPlantCounters() { seedIdx = 0; _bagCompostIdx = 0; _compostUsed = 0; }

// Returns true if compost is available for this plant action — uses in-game
// compost first, then falls back to staking a compost NFT from the bag.
function resolveCompost(pendingActions, plotLabel) {
  const available = compostBalance - _compostUsed;
  if (available > 0) { _compostUsed++; return true; }
  if (_bagCompostIdx < bagCompostArray.length) {
    const nft = bagCompostArray[_bagCompostIdx++];
    pendingActions.push({
      account: ATOMIC_CTR, name: "transfer",
      data: { from: actor(), to: CONTRACT, asset_ids: [nft.asset_id], memo: "deposit:compost" },
      _label: `🌿 Stake compost NFT (${nft.asset_id}) for ${plotLabel}`
    });
    return true;
  }
  return false;
}

function queuePlantActions(item, pendingActions) {
  const plotLabel = `${item.plot_name} slot ${item.index}`;

  // Try in-game seeds first
  if (seedIdx < seedArray.length) {
    const seed = seedArray[seedIdx];
    if (!resolveCompost(pendingActions, plotLabel)) return; // no compost anywhere — skip
    seedIdx++;
    pendingActions.push({
      account: CONTRACT, name: "plant",
      data: { owner: actor(), plot_asset_id: item.plot_asset_id, slot_index: item.index, seed_tpl_id: seed.seed_tpl_id, seed_batch_id: Number(seed.seed_asset_id) },
      _label: `🌱 Plant (tpl ${seed.seed_tpl_id}) — ${plotLabel}`
    });
    return;
  }
  // No in-game seeds available for this slot — bag seed NFTs are opened
  // unconditionally elsewhere (buildOpenSeedActions), not planted per-slot.
}

// ─── Crafting mechanics (ported from farm.html) ───────────────────────────
function buildBuyPackActions(balances) {
  const totalSeeds = seedArray.length + bagSeedArray.length;
  if (totalSeeds >= SEED_STOCK_THRESHOLD) return [];

  // Big crate (blend 2) takes priority over the small crate when affordable.
  if (balances.tomatoe > BIG_PACK_COST) {
    const numPacks = Math.floor(balances.tomatoe / BIG_PACK_COST);
    if (numPacks < 1) return [];
    const mainQty = (BIG_PACK_MAIN * numPacks).toFixed(8);
    const feeQty  = (BIG_PACK_FEE  * numPacks).toFixed(8);
    return [
      { account: MAESTRO_CTR, name: "transfer", data: { from: actor(), to: CONTRACT, quantity: `${mainQty} TOMATOE`, memo: `BUY:${BIG_PACK_BLEND_ID}:${numPacks}` }, _label: `🛒 Buy ${numPacks} big seed pack${numPacks > 1 ? "s" : ""} — ${mainQty} TOMATOE` },
      { account: MAESTRO_CTR, name: "transfer", data: { from: actor(), to: "swap.alcor", quantity: `${feeQty} TOMATOE`, memo: "swapexactin#3271#hzenu.c.wam#1.00000000 WAX@eosio.token#0" }, _label: `🛒 Pack purchase earnings — ${feeQty} TOMATOE` }
    ];
  }

  if (balances.tomatoe > TOMATOE_PACK_COST) {
    const numPacks = Math.floor(balances.tomatoe / TOMATOE_PACK_COST);
    if (numPacks < 1) return [];
    const mainQty = (TOMATOE_PACK_MAIN * numPacks).toFixed(8);
    const feeQty  = (TOMATOE_PACK_FEE  * numPacks).toFixed(8);
    return [
      { account: MAESTRO_CTR, name: "transfer", data: { from: actor(), to: CONTRACT, quantity: `${mainQty} TOMATOE`, memo: `BUY:${PACK_BLEND_ID}:${numPacks}` }, _label: `🛒 Buy ${numPacks} seed pack${numPacks > 1 ? "s" : ""} — ${mainQty} TOMATOE` },
      { account: MAESTRO_CTR, name: "transfer", data: { from: actor(), to: "swap.alcor", quantity: `${feeQty} TOMATOE`, memo: "swapexactin#3271#hzenu.c.wam#1.00000000 WAX@eosio.token#0" }, _label: `🛒 Pack purchase earnings — ${feeQty} TOMATOE` }
    ];
  }

  return [];
}

function buildOpenPackActions() {
  // Open every crate in the bag's "packs" schema, regardless of recipe_id —
  // there are more crate types than just the two blends we buy (e.g. the
  // EcoCrate, recipe_id 3), and all of them need to be opened. Skip any
  // pack missing a recipe_id so we never send a broken "BLEND:null" memo.
  return bagPackArray
    .filter(p => p.recipe_id !== null && p.recipe_id !== undefined)
    .map(p => ({
      account: ATOMIC_CTR, name: "transfer",
      data: { from: actor(), to: CONTRACT, asset_ids: [p.asset_id], memo: `BLEND:${p.recipe_id}` },
      _label: `🎁 Open pack (${p.asset_id})`
    }));
}

// Unconditionally opens every seed NFT sitting in the bag, regardless of
// whether there's currently an empty plot slot for it — decoupled from
// queuePlantActions so seed NFTs never sit unused waiting for a slot.
function buildOpenSeedActions() {
  return bagSeedArray.map(s => ({
    account: ATOMIC_CTR, name: "transfer",
    data: { from: actor(), to: CONTRACT, asset_ids: [s.seed_asset_id], memo: "open:seedpack" },
    _label: `📦 Open seed NFT (${s.seed_asset_id})`
  }));
}

function buildCompostBlendActions(availableCompost) {
  const actions = [];
  const eligible = availableCompost.filter(c => c.template_id === COMPOST_TPL_ID);
  if (eligible.length < COMPOST_BLEND_MIN) return actions;
  const numBlends = Math.floor(eligible.length / COMPOST_BLEND_BATCH);
  for (let i = 0; i < numBlends; i++) {
    const batch = eligible.slice(i * COMPOST_BLEND_BATCH, (i + 1) * COMPOST_BLEND_BATCH);
    const ids = batch.map(c => c.asset_id);
    actions.push({ account: MAESTRO_CTR, name: "transfer", data: { from: actor(), to: CONTRACT, quantity: COMPOST_BLEND_TOMATOE_QTY, memo: `BLEND:${COMPOST_BLEND_ID}` }, _label: `🧪 Compost blend #${i + 1} — ${COMPOST_BLEND_TOMATOE_QTY}` });
    actions.push({ account: MAESTRO_CTR, name: "transfer", data: { from: actor(), to: CONTRACT, quantity: COMPOST_BLEND_BANANAZ_QTY, memo: `BLEND:${COMPOST_BLEND_ID}` }, _label: `🧪 Compost blend #${i + 1} — ${COMPOST_BLEND_BANANAZ_QTY}` });
    actions.push({ account: ATOMIC_CTR, name: "transfer", data: { from: actor(), to: CONTRACT, asset_ids: ids, memo: `BLEND:${COMPOST_BLEND_ID}` }, _label: `🧪 Compost blend #${i + 1} — 10 NFTs` });
  }
  return actions;
}

function buildEcoBlendActions(availableCompost) {
  const actions = [];
  const eligible = availableCompost.filter(c => c.template_id === ECO_COMPOST_TPL_ID);
  if (eligible.length < ECO_BLEND_MIN) return actions;
  const numBlends = Math.floor(eligible.length / ECO_BLEND_BATCH);
  for (let i = 0; i < numBlends; i++) {
    const batch = eligible.slice(i * ECO_BLEND_BATCH, (i + 1) * ECO_BLEND_BATCH);
    const ids = batch.map(c => c.asset_id);
    actions.push({ account: MAESTRO_CTR, name: "transfer", data: { from: actor(), to: CONTRACT, quantity: ECO_BLEND_TOMATOE_QTY, memo: `BLEND:${ECO_BLEND_ID}` }, _label: `🧬 Eco compost blend #${i + 1} — ${ECO_BLEND_TOMATOE_QTY}` });
    actions.push({ account: ATOMIC_CTR, name: "transfer", data: { from: actor(), to: CONTRACT, asset_ids: ids, memo: `BLEND:${ECO_BLEND_ID}` }, _label: `🧬 Eco compost blend #${i + 1} — 3 NFTs` });
  }
  return actions;
}

function buildStakePlotActions() {
  return bagPlotArray.map(p => ({
    account: ATOMIC_CTR, name: "transfer",
    data: { from: actor(), to: CONTRACT, asset_ids: [p.asset_id], memo: `stake:plot:${FARM_ID}` },
    _label: `🗺️ Stake plot NFT (${p.asset_id})`
  }));
}

function buildMaximizeTransfer(fromEnergy, maxEnergy, cinderBudget, isFinal) {
  if (fromEnergy >= maxEnergy || cinderBudget <= 0) return null;
  const deficit = maxEnergy - fromEnergy;
  const idealCinder = Math.ceil(deficit / CINDER_PER_ENERGY);
  const usedCinder = Math.min(idealCinder, Math.floor(cinderBudget));
  if (usedCinder <= 0) return null;
  const toEnergy = Math.min(maxEnergy, fromEnergy + usedCinder * CINDER_PER_ENERGY);
  return {
    action: {
      account: CINDER_CTR, name: "transfer",
      data: { from: actor(), to: CONTRACT, quantity: `${usedCinder}.000000 CINDER`, memo: "poweruser" },
      _label: `⚡ Maximize energy (${fromEnergy} → ${toEnergy}, +${usedCinder} CINDER)`
    },
    newEnergy: toEnergy,
    newBudget: cinderBudget - usedCinder
  };
}

function applyEnergyMaximize(actions, startEnergy, maxEnergy, availableCinder) {
  let energy = startEnergy;
  let cinderBudget = typeof availableCinder === "number" ? Math.max(0, availableCinder) : Infinity;
  const out = [];
  let i = 0;
  while (i < actions.length) {
    const action = actions[i];
    const cost = ENERGY_COST[action.name] || 0;
    if (cost > 0 && energy < cost) {
      const topUp = buildMaximizeTransfer(energy, maxEnergy, cinderBudget, false);
      if (topUp) { out.push(topUp.action); energy = topUp.newEnergy; cinderBudget = topUp.newBudget; }
    }
    if (cost > 0 && energy < cost) {
      if (out.length > 0 && actions[i - 1]?.account === ATOMIC_CTR && actions[i - 1]?.name === "transfer" && out[out.length - 1] === actions[i - 1]) out.pop();
      if (action.name === "claimmach") {
        const mid = action.data?.machine_id;
        let j = i + 1;
        while (j < actions.length && (actions[j].data?.machine_id === mid || actions[j].data?.memo?.includes(`machine:${mid}`))) j++;
        i = j; continue;
      }
      i++; continue;
    }
    if (cost > 0) energy -= cost;
    out.push(action); i++;
  }
  if (out.length > 0) {
    const finalTopUp = buildMaximizeTransfer(energy, maxEnergy, cinderBudget, true);
    if (finalTopUp) out.push(finalTopUp.action);
  }
  return out;
}

function convertUInt64Fields(data) {
  if (!data || typeof data !== "object") return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (UINT64_FIELDS.has(k) && v != null) { try { out[k] = UInt64.from(String(v)); } catch { out[k] = v; } }
    else out[k] = v;
  }
  return out;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Fetching state for ${actor()}…`);

  const plotsData = await apiFetch(`/api/farms/${FARM_ID}/plots`);
  const myPlots = (plotsData.plots || []).filter(p => p.owner === actor());
  const farmSlots = [];
  myPlots.forEach(plot => (plot.slots || []).forEach(slot =>
    farmSlots.push({ ...slot, plot_asset_id: plot.plot_asset_id, plot_name: plot.name })));

  const playerStatus   = await apiFetch(`/api/player/${actor()}/status`);
  seedArray      = buildSeedArray(playerStatus);
  compostBalance = Number(playerStatus?.compost?.balance ?? 0);

  // Bag NFT seeds/compost — always checked, even when in-game items exist,
  // matching farm.html's behavior.
  let bagData = null;
  try { bagData = await apiFetch(`/bag/${actor()}`); } catch { /* no bag data available */ }
  const bagAssets = bagData?.assets || [];
  bagSeedArray = bagAssets
    .filter(a => a.schema === "seeds" || (a.nft_type || "").toLowerCase().includes("seed"))
    .map(a => ({ seed_asset_id: a.asset_id, seed_tpl_id: a.template_id || 0 }))
    .sort((a, b) => b.seed_tpl_id - a.seed_tpl_id);
  bagCompostArray = bagAssets
    .filter(a => a.schema === "compost" || (a.nft_type || "").toLowerCase().includes("compost"))
    .map(a => ({ asset_id: a.asset_id, template_id: a.template_id || 0 }))
    // Regular Compost Bag (COMPOST_TPL_ID) is used before EcoFusion Compost
    // (ECO_COMPOST_TPL_ID) — the latter is reserved for eco blending, not
    // spent on ordinary planting unless it's all that's left.
    .sort((a, b) => {
      const rank = t => t === COMPOST_TPL_ID ? 0 : t === ECO_COMPOST_TPL_ID ? 1 : 2;
      return rank(a.template_id) - rank(b.template_id);
    });
  bagPackArray = bagAssets
    .filter(a => a.schema === "packs" || (a.nft_type || "").toLowerCase().includes("crate"))
    .map(a => ({ asset_id: a.asset_id, template_id: a.template_id || 0, recipe_id: a.recipe_id ?? null }));
  bagPlotArray = bagAssets
    .filter(a => a.schema === "land" || (a.nft_type || "").toLowerCase().includes("plot"))
    .map(a => ({ asset_id: a.asset_id, template_id: a.template_id || 0 }));

  console.log(`DEBUG: in-game seeds = ${seedArray.length}, bag seeds = ${bagSeedArray.length}, in-game compost = ${compostBalance}, bag compost = ${bagCompostArray.length}, bag packs = ${bagPackArray.length}, bag plots = ${bagPlotArray.length}`);

  const energyData      = await apiFetch(`/userenergy/${actor()}`);
  const machineData     = await apiFetch(`/machines/${actor()}`);
  const balances        = await fetchBalances();
  const rucoinUsdPrice  = await fetchRucoinPrice();

  resetPlantCounters();
  const pendingActions = [];
  let hasHarvestAction = false;
  const now = Date.now();

  farmSlots.forEach(item => {
    const lastAction = new Date(item.last_action + "Z").getTime();
    const diff = now - lastAction;

    if (item.state === "READY") {
      pendingActions.push({ account: CONTRACT, name: "harvest", data: { owner: actor(), plot_asset_id: item.plot_asset_id, slot_index: item.index }, _label: `🌾 Harvest — ${item.plot_name} slot ${item.index}` });
      hasHarvestAction = true;
      queuePlantActions(item, pendingActions);
    } else if (item.state === "EMPTY") {
      queuePlantActions(item, pendingActions);
    } else if (diff < HOURS_8) {
      // still growing — nothing to do
    } else if (item.tick_goal > 0 && item.tick + 1 === item.tick_goal && item.state !== "READY" && item.state !== "EMPTY") {
      pendingActions.push({ account: CONTRACT, name: "water", data: { owner: actor(), plot_asset_id: item.plot_asset_id, slot_index: item.index }, _label: `💧 Water (last) — ${item.plot_name} slot ${item.index}` });
      pendingActions.push({ account: CONTRACT, name: "harvest", data: { owner: actor(), plot_asset_id: item.plot_asset_id, slot_index: item.index }, _label: `🌾 Harvest (after last water) — ${item.plot_name} slot ${item.index}` });
      hasHarvestAction = true;
      queuePlantActions(item, pendingActions);
    } else {
      pendingActions.push({ account: CONTRACT, name: "water", data: { owner: actor(), plot_asset_id: item.plot_asset_id, slot_index: item.index }, _label: `💧 Water — ${item.plot_name} slot ${item.index}` });
    }
  });

  // Crafting mechanics: buy packs, open packs, blend compost, stake plots.
  // Compost NFTs already claimed for plot staking above (indices < _bagCompostIdx)
  // are excluded so blends never compete with planting for the same NFT.
  const availableCompost = bagCompostArray.slice(_bagCompostIdx);
  pendingActions.push(...buildBuyPackActions(balances));
  pendingActions.push(...buildOpenPackActions());
  pendingActions.push(...buildOpenSeedActions());
  pendingActions.push(...buildCompostBlendActions(availableCompost));
  pendingActions.push(...buildEcoBlendActions(availableCompost));
  pendingActions.push(...buildStakePlotActions());

  if (MACHINES_ENABLED) {
    (machineData?.machines || []).forEach(machine => {
      if (!isMachineClaimable(machine)) return;
      const machineId = machine.machine_id;
      const recipeId  = machine.current_recipe_id || 1;
      pendingActions.push({ account: CONTRACT, name: "claimmach", data: { user: actor(), machine_id: Number(machineId) }, _label: `📦 Claim machine ${machineId}` });
      pendingActions.push({ account: MAESTRO_CTR, name: "transfer", data: { from: actor(), to: CONTRACT, quantity: "10000.00000000 TOMATOE", memo: `recipe:machine:${machineId}:${recipeId}` }, _label: "🍅 Deposit 10k TOMATOE" });
      pendingActions.push({ account: MAESTRO_CTR, name: "transfer", data: { from: actor(), to: CONTRACT, quantity: "10000.00000000 BANANAZ", memo: `recipe:machine:${machineId}:${recipeId}` }, _label: "🍌 Deposit 10k BANANAZ" });
      pendingActions.push({ account: CONTRACT, name: "startmach", data: { user: actor(), machine_id: Number(machineId), recipe_id: Number(recipeId), batch_size: 1 }, _label: `▶️ Start machine ${machineId}` });
    });
  }

  if (hasHarvestAction) {
    pendingActions.push({ account: CONTRACT, name: "claimseedrwd", data: { owner: actor() }, _label: "🌱 Claim Seed Reward" });
  }

  const maxEnergy = energyData?.max ?? 250;
  const curEnergy = energyData?.energy ?? 0;
  let builtActions = applyEnergyMaximize(pendingActions, curEnergy, maxEnergy, balances.cinder);

  if (rucoinUsdPrice) {
    const feePoints = calculateFeePoints(builtActions);
    const feeAction = buildFeeAction(feePoints, rucoinUsdPrice);
    if (feeAction) builtActions = [...builtActions, feeAction];
  }

  if (builtActions.length === 0) {
    console.log("Nothing to do — farm is up to date.");
    return;
  }

  console.log(`Queued ${builtActions.length} actions:`);
  builtActions.forEach(a => console.log(" -", a._label || a.name));

  const actions = builtActions.map(({ _label, ...a }) => ({
    ...a,
    authorization: [perm()],
    data: convertUInt64Fields(a.data)
  }));

  const result = await session.transact({ actions }, { broadcast: true });
  console.log("✅ Transaction sent:", result.resolved?.transaction?.id?.toString() || result);
}

main().catch(e => {
  console.error("❌ Bot run failed:", e.message || e);
  process.exit(1);
});
