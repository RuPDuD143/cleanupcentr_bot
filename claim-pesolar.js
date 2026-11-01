const fs = require('fs');
const path = require('path');
const { Api, JsonRpc } = require('eosjs');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');

const ACCOUNT    = process.env.WAX_ACCOUNT    || 'pesolargame1';
const PERMISSION = process.env.WAX_PERMISSION || 'generator';
const ENDPOINT   = process.env.WAX_ENDPOINT   || 'https://wax.greymass.com';
const STATE      = path.join(__dirname, 'state-pesolar.json');

// 24h10m between claims (for 24h25m use (24 * 60 + 25))
const INTERVAL = (24 * 60 + 10) * 60 * 1000;
// wait this long after a failed attempt before trying again
const RETRY    = 30 * 60 * 1000;

const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');

(async () => {
  const key = process.env.WAX_PRIVATE_KEY;
  if (!key) { console.error('WAX_PRIVATE_KEY is not set'); process.exit(1); }

  const now = Date.now();
  const s = load();

  if (s.lastClaim && now - s.lastClaim < INTERVAL) {
    const mins = Math.ceil((INTERVAL - (now - s.lastClaim)) / 60000);
    console.log(`[${ACCOUNT}] Not due yet (~${mins} min left).`);
    return;
  }
  if (s.lastFail && now - s.lastFail < RETRY) {
    console.log(`[${ACCOUNT}] Backing off after a recent failure.`);
    return;
  }

  const rpc = new JsonRpc(ENDPOINT, { fetch });
  const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([key]) });

  try {
    const res = await api.transact({
      actions: [{
        account: 'eosio',
        name: 'claimgbmvote',
        authorization: [{ actor: ACCOUNT, permission: PERMISSION }],
        data: { owner: ACCOUNT },
      }],
    }, { blocksBehind: 3, expireSeconds: 60 });

    save({ lastClaim: now });
    console.log(new Date().toISOString(), `[${ACCOUNT}] claimed`, res.transaction_id);
  } catch (e) {
    save({ ...s, lastFail: now });
    console.error(new Date().toISOString(), `[${ACCOUNT}] failed:`, e.message);
    process.exit(1);
  }
})();
