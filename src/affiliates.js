import axios from 'axios';

// Removed the specific API link. Leave it empty until you have your new API.
const BASE = process.env.AFFILIATE_API || ''; 
const CODE = process.env.AFFILIATE_CODE || '';
const APIKEY = process.env.AFFILIATE_API_KEY || '';
const BY = process.env.AFFILIATE_BY || 'wager';
const SORT = process.env.AFFILIATE_SORT || 'desc';
const TAKE = String(process.env.AFFILIATE_TAKE || '100');
const SKIP = String(process.env.AFFILIATE_SKIP || '0');
const GT = String(process.env.AFFILIATE_GT || '1672531200000');
const CACHE_MS = Number(process.env.AFFILIATE_CACHE_MS || 60000);

const cache = new Map();
function ttlGet(k){const h=cache.get(k);if(!h)return null;if(h.exp<Date.now()){cache.delete(k);return null}return h.val}
function ttlSet(k,v,ms){cache.set(k,{val:v,exp:Date.now()+ms})}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

function toPlayers(raw){
  if(!Array.isArray(raw)) return [];
  return raw.map((u,i)=>({
    id: String(u.uuid || u.id || i),
    name: String(u.name || u.username || `Player ${i+1}`),
    avatar: u.steam_avatar || null,
    points: Number(u.wagered ?? u.wager ?? u.points ?? 0)
  }));
}

// Generates fake data for testing so your frontend isn't blank
function getDummyData() {
  return [
    { id: '1', name: 'Hrislit', avatar: null, points: 150000 },
    { id: '2', name: 'GamerX', avatar: null, points: 120000 },
    { id: '3', name: 'CryptoKing', avatar: null, points: 90000 },
    { id: '4', name: 'WhaleSniper', avatar: null, points: 50000 },
    { id: '5', name: 'LuckyCharm', avatar: null, points: 25000 },
    { id: '6', name: 'NoobMaster', avatar: null, points: 10000 }
  ];
}

export async function fetchAffiliateRaw() {
  // Use dummy data if API isn't set up yet
  if (!BASE || !APIKEY || !CODE) return getDummyData(); 

  const lt = String(Date.now());
  const qs = new URLSearchParams({ code: CODE, gt: GT, lt, by: BY, sort: SORT, take: TAKE, skip: SKIP }).toString();
  const url = `${BASE}?${qs}`;
  const cached = ttlGet(url + ':raw'); if (cached) return cached;

  for (let a = 0; a < 5; a++) {
    try {
      const res = await axios.get(url, {
        headers: { 'x-apikey': APIKEY, accept: 'application/json' },
        timeout: 15000
      });
      const payload = Array.isArray(res.data)
        ? res.data
        : (res.data && Array.isArray(res.data.data) ? res.data.data : []);
      ttlSet(url + ':raw', payload, CACHE_MS);
      return payload;
    } catch (e) {
      const s = e?.response?.status || 0;
      if (s === 429 || (s >= 500 && s < 600)) {
        const ra = e?.response?.headers?.['retry-after'];
        const base = ra ? Number(ra) * 1000 : Math.min(15000, 600 * (2 ** a));
        const jitter = Math.floor(Math.random() * 250);
        await sleep(base + jitter);
        continue;
      }
      return [];
    }
  }
  return [];
}

export async function fetchAffiliate() {
  // Use dummy data if API isn't set up yet
  if (!BASE || !APIKEY || !CODE) return getDummyData(); 

  const lt = String(Date.now());
  const qs = new URLSearchParams({ code: CODE, gt: GT, lt, by: BY, sort: SORT, take: TAKE, skip: SKIP }).toString();
  const url = `${BASE}?${qs}`;
  const cached = ttlGet(url + ':players'); if (cached) return cached;

  try {
    const res = await axios.get(url, {
      headers: { 'x-apikey': APIKEY, accept: 'application/json' },
      timeout: 15000
    });
    const payload = Array.isArray(res.data)
      ? res.data
      : (res.data && Array.isArray(res.data.data) ? res.data.data : []);
    const players = toPlayers(payload);
    ttlSet(url + ':players', players, CACHE_MS);
    return players;
  } catch {
    return [];
  }
}
