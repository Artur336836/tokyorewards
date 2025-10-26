import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';
import { fetchAffiliate, fetchAffiliateRaw } from './src/affiliates.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';

const app = express();

// ---------- FS setup ----------
const UPLOAD_DIR = path.resolve('uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));
const upload = multer({ dest: path.join(UPLOAD_DIR, 'tmp') });
const SETTINGS_PATH = path.join(UPLOAD_DIR, 'settings.json');

function saveSettings() {
  try {
    const data = { hero, countdownEnd };
    const tmp = SETTINGS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, SETTINGS_PATH);
  } catch (e) {
    console.warn('[settings] save failed:', e?.message || e);
  }
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') {
      if (parsed.countdownEnd) countdownEnd = parsed.countdownEnd;
      if (parsed.hero && typeof parsed.hero === 'object') {
        hero = { ...hero, ...parsed.hero }; // merge, keep fields you added later
      }
    }
    console.log('[settings] loaded from disk');
  } catch (e) {
    console.warn('[settings] load failed:', e?.message || e);
  }
}
loadSettings();


// ---------- HTTP + Socket ----------
const server = http.createServer(app);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const io = new IOServer(server, { cors: { origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN } });

const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const INTERVAL_CRON = process.env.AFFILIATE_CRON || '*/30 * * * *'; // default: every 30 min

// ---------- State ----------
let leaderboard = [];
let updatedAt = null;

// date-windowed leaderboard controls
let contestStart = null; // ISO string or null
let contestEnd   = null; // ISO string or null

// cache + history paths
const CACHE_PATH = path.join(UPLOAD_DIR, 'leaderboard.json');
const HIST_PATH  = path.join(UPLOAD_DIR, 'leaderboard-history.ndjson');

// misc content
let prizes = [175, 100, 70, 50, 35, 25, 15, 10, 10, 10];
let countdownEnd = process.env.COUNTDOWN_END ? new Date(process.env.COUNTDOWN_END).toISOString() : null;
let announcement = process.env.ANNOUNCEMENT || '';
let hero = {
  headline: '$ 500 CSGOWIN WAGER LEADERBOARD',
  sub1: 'Top 10 players with the highest wagers past 2 weeks win a share of $500',
  sub2: 'The leaderboard updates every 30 minutes.',
  linkText: process.env.HERO_LINK_TEXT || '',
  linkUrl: process.env.HERO_LINK_URL || '',
  headlineColor: '#ffffff',
  sub1Color: '#cbd5e1',
  sub2Color: '#cbd5e1',
  headlineGlow: '0 0 12px rgba(255,255,255,0.8)',
  imageUrl: process.env.HERO_IMAGE_URL ||'',
  imageGlow: 'drop-shadow(0 0 16px rgba(251, 255, 0, 0.65))',
  coinImageUrl: undefined, // NEW
};

// ---------- Middlewares ----------
app.use(express.json());
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN }));

// ---------- Helpers ----------
function sortPlayers(list) {
  return (Array.isArray(list) ? list : [])
    .map(x => ({ ...x, points: Number(x?.points) || 0 }))
    .sort((a, b) => b.points - a.points);
}
function isSane(list) {
  return Array.isArray(list) && list.length > 0;
}

function saveCache() {
  try {
    const tmp = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt, data: leaderboard }), 'utf8');
    fs.renameSync(tmp, CACHE_PATH);
  } catch (e) {
    console.warn('[cache] save failed:', e?.message || e);
  }
}
function loadCacheIfAny() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return;
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.data)) {
      leaderboard = parsed.data;
      updatedAt = parsed.updatedAt || new Date().toISOString();
      console.log(`[cache] loaded ${leaderboard.length} records from disk`);
    }
  } catch (e) {
    console.warn('[cache] load failed:', e?.message || e);
  }
}
loadCacheIfAny();

function appendHistorySnapshot(list) {
  try {
    const row = {
      ts: Date.now(),
      p: Object.fromEntries((list || []).map(u => [String(u.id), Number(u.points || 0)]))
    };
    fs.appendFileSync(HIST_PATH, JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    console.warn('[history] append failed:', e?.message || e);
  }
}

function readHistory() {
  const out = [];
  try {
    if (!fs.existsSync(HIST_PATH)) return out;
    const lines = fs.readFileSync(HIST_PATH, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) { try { out.push(JSON.parse(line)); } catch {} }
  } catch {}
  return out.sort((a, b) => a.ts - b.ts);
}

// windowed points = max(points) in [start,end] - last points before start
function computeWindowed(startMs, endMs) {
  const hist = readHistory();
  if (!hist.length) return [];

  const before = new Map();       
  const firstIn = new Map();      
  const maxIn   = new Map();      
  for (const snap of hist) {
    const t = snap.ts;
    const P = snap.p || {};
    if (t < startMs) {
      // track last value before start
      for (const [id, pts] of Object.entries(P)) before.set(id, pts);
    } else if (t <= endMs) {
      // inside window
      for (const [id, pts] of Object.entries(P)) {
        if (!firstIn.has(id)) firstIn.set(id, pts);          // first seen at/after start
        const cur = maxIn.get(id);
        if (cur == null || pts > cur) maxIn.set(id, pts);    // peak in window
      }
    }
  }

  const results = [];
  const ids = new Set([...before.keys(), ...firstIn.keys(), ...maxIn.keys()]);
  for (const id of ids) {
    const baseline = before.has(id) ? before.get(id) : (firstIn.get(id) ?? 0);
    const peak = maxIn.get(id);
    if (peak == null) continue; // never seen inside window
    const gain = Math.max(0, peak - baseline);
    if (gain > 0) {
      const cur = (leaderboard || []).find(u => String(u.id) === id);
      results.push({
        id,
        name: cur?.name ?? 'Player',
        avatar: cur?.avatar ?? null,
        points: gain
      });
    }
  }

  results.sort((a,b) => b.points - a.points);
  return results;
}


// ---------- Refresh loop ----------
async function refresh() {
  // Optionally freeze further updates after countdown end
  if (countdownEnd && Date.now() > new Date(countdownEnd).getTime()) {
    console.log('⛔ Countdown ended — stopping API updates (leaderboard frozen).');
    return;
  }

  try {
    const players = await fetchAffiliate();
    const sorted  = sortPlayers(players);

    if (isSane(sorted)) {
      leaderboard = sorted;
      updatedAt   = new Date().toISOString();
      saveCache();
      appendHistorySnapshot(leaderboard); // snapshot for window math
      io.emit('leaderboard:update', leaderboard);
      console.log(`[refresh] ok: ${leaderboard.length} players at ${updatedAt}`);
    } else {
      console.warn('[refresh] empty/invalid list; keeping last good cache');
    }
  } catch (err) {
    console.error('[refresh] failed:', err?.message || err);
    // keep last good cache
  }
}
cron.schedule(INTERVAL_CRON, refresh);
setTimeout(() => { refresh().catch(()=>{}); }, 1500);

// ---------- Health ----------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, updatedAt, count: leaderboard.length });
});

// ---------- Public API ----------
app.get('/api/leaderboard', (req, res) => {
  if (contestStart && contestEnd) {
    const s = Date.parse(contestStart), e = Date.parse(contestEnd);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
      return res.json(computeWindowed(s, e));
    }
  }
  res.json(leaderboard);
});

app.get('/api/leaderboard/meta', (req, res) => {
  res.json({ updatedAt, count: leaderboard.length });
});

// Optional ad-hoc preview of any range
app.get('/api/leaderboard/range', (req, res) => {
  const s = Date.parse(req.query.start ?? ''), e = Date.parse(req.query.end ?? '');
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) {
    return res.status(400).json({ error: 'invalid range' });
  }
  res.json(computeWindowed(s, e));
});

app.get('/api/countdown', (req, res) => res.json({ end: countdownEnd }));
app.get('/api/announcement', (req, res) => res.json({ announcement }));
app.get('/api/prizes', (req, res) => res.json({ prizes }));
app.get('/api/hero', (req, res) => res.json(hero));

// ---------- Contest window (Admin) ----------
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: 'not_found' });
  const token = req.get('x-admin-token');
  if (token !== ADMIN_TOKEN) return res.status(404).json({ error: 'not_found' });
  next();
}
const adminLimiter = rateLimit({ windowMs: 60_000, max: 20 });

app.get('/api/contest', (req, res) => res.json({ start: contestStart, end: contestEnd }));
app.post('/api/contest', requireAdmin, (req, res) => {
  const { start, end } = req.body || {};
  contestStart = start ? new Date(start).toISOString() : null;
  contestEnd   = end   ? new Date(end).toISOString()   : null;
  res.json({ start: contestStart, end: contestEnd });
});

// ---------- Admin helpers ----------
app.get('/api/admin/ping', adminLimiter, requireAdmin, (req, res) => res.json({ ok: true }));

app.post('/api/prizes', requireAdmin, (req, res) => {
  const arr = req.body?.prizes;
  if (!Array.isArray(arr) || arr.length !== 10 || !arr.every(x => Number.isFinite(Number(x)))) {
    return res.status(400).json({ error: 'prizes must be an array of 10 numbers' });
  }
  prizes = arr.map(x => Math.floor(Number(x)));
  io.emit('prizes:update', prizes);
  res.json({ prizes });
});

app.post('/api/countdown', requireAdmin, (req, res) => {
  let t = req.body?.end;
  if (typeof t === 'string' && /^\d+$/.test(t)) t = Number(t);
  if (typeof t === 'number') t = new Date(t);
  if (typeof t === 'string') {
    const raw = t.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
      t = new Date(raw.replace(' ', 'T'));
    }
  }
  const dt = t instanceof Date ? t.getTime() : Date.parse(String(t || ''));
  if (!Number.isFinite(dt)) return res.status(400).json({ error: 'invalid end' });

  countdownEnd = new Date(dt).toISOString();
  saveSettings();                         // <— add this
  io.emit('countdown:update', { end: countdownEnd });
  res.json({ end: countdownEnd });

});

// hero main image upload
app.post('/api/hero/image', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const finalPath = path.join(UPLOAD_DIR, 'hero' + path.extname(req.file.originalname || '.png'));
  fs.renameSync(req.file.path, finalPath);
  const publicUrl = '/uploads/' + path.basename(finalPath);
  hero.imageUrl = publicUrl;
  saveSettings();
  io.emit('hero:update', hero);
  res.json({ imageUrl: publicUrl });
});

// NEW: coin image upload
app.post('/api/hero/coin-image', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const finalPath = path.join(UPLOAD_DIR, 'coin' + path.extname(req.file.originalname || '.png'));
  fs.renameSync(req.file.path, finalPath);
  const publicUrl = '/uploads/' + path.basename(finalPath);
  hero.coinImageUrl = publicUrl;
  saveSettings();
  io.emit('hero:update', hero);
  res.json({ coinImageUrl: publicUrl });
});

// hero settings
app.post('/api/hero', requireAdmin, (req, res) => {
  const {
    headline, sub1, sub2,
    linkText, linkUrl,
    headlineColor, sub1Color, sub2Color,
    headlineGlow, imageUrl, imageGlow,
    coinImageUrl, // NEW
  } = req.body || {};

  hero = {
    ...hero,
    headline: headline ?? hero.headline,
    sub1: sub1 ?? hero.sub1,
    sub2: sub2 ?? hero.sub2,
    linkText: linkText ?? hero.linkText,
    linkUrl: linkUrl ?? hero.linkUrl,
    headlineColor: headlineColor ?? hero.headlineColor,
    sub1Color: sub1Color ?? hero.sub1Color,
    sub2Color: sub2Color ?? hero.sub2Color,
    headlineGlow: headlineGlow ?? hero.headlineGlow,
    imageUrl: imageUrl ?? hero.imageUrl,
    imageGlow: imageGlow ?? hero.imageGlow,
    coinImageUrl: coinImageUrl ?? hero.coinImageUrl,
  };
  saveSettings();
  io.emit('hero:update', hero);
  res.json(hero);
});

app.post('/api/announcement', requireAdmin, (req, res) => {
  announcement = req.body?.announcement || '';
  io.emit('announcement:update', { announcement });
  res.json({ announcement });
});

app.post('/api/admin/refresh', requireAdmin, async (req, res) => {
  await refresh();
  res.json({ ok: true, count: leaderboard.length, updatedAt });
});

// IDs export
app.get('/api/ids', requireAdmin, async (req, res) => {
  try {
    const raw = await fetchAffiliateRaw();
    const list = Array.isArray(raw) ? raw : [];

    const pick = (obj, ...paths) => {
      for (const p of paths) {
        let cur = obj;
        for (const seg of String(p).split('.')) {
          if (cur && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg];
          else { cur = undefined; break; }
        }
        if (cur != null) return cur;
      }
      return undefined;
    };

    const BASE64 = 76561197960265728n;
    function toSteam64({ steam64, steam2, steam3, accountId }) {
      if (steam64 != null) {
        const s = String(steam64).trim();
        if (/^\d{17}$/.test(s)) return s;
        try { const n = BigInt(s); if (n >= BASE64) return n.toString(); } catch {}
      }
      if (steam2) {
        const s = String(steam2).trim();
        const m = /^STEAM_[0-5]:([01]):(\d+)$/.exec(s);
        if (m) {
          const acct = BigInt(m[2]);
          const universe = BigInt(m[1]);
          return (BASE64 + acct * 2n + (universe === 1n ? 1n : 0n)).toString();
        }
      }
      if (steam3) {
        const s = String(steam3).trim();
        const m = /^\[U:1:(\d+)\]$/.exec(s);
        if (m) {
          const acct = BigInt(m[1]);
          return (BASE64 + acct).toString();
        }
      }
      if (accountId != null && String(accountId).trim() !== '') {
        try { const a = BigInt(String(accountId).trim()); return (BASE64 + a).toString(); } catch {}
      }
      return '';
    }

    const mapped = list.map((u, i) => {
      const name = pick(
        u, 'name','username','displayName',
        'user.name','user.username','user.displayName',
        'profile.name','profile.username','profile.displayName'
      ) ?? `Player ${i + 1}`;

      const id = pick(
        u, 'id','uuid','user_id','userId','userID','user','account_id',
        'user.id','user.uuid','profile.id','profile.uuid'
      );
      const uuid = pick(u, 'uuid','user_uuid','user.uuid','profile.uuid');

      const steam64Raw = pick(
        u,
        'steamid64','steam_id_64','steamId64',
        'user.steamid64','user.steam_id_64','user.steamId64',
        'profile.steamid64','profile.steam_id_64','profile.steamId64',
        'steam.steamid64','steam.steam_id_64','steam.steamId64'
      );
      const steam2 = pick(
        u,
        'steamid','steam_id','steamId',
        'user.steamid','user.steam_id','user.steamId',
        'profile.steamid','profile.steam_id','profile.steamId',
        'steam.id'
      );
      const steam3 = pick(
        u,
        'steamid3','steam_id3','steamId3',
        'user.steamid3','user.steam_id3','user.steamId3',
        'profile.steamid3','profile.steam_id3','profile.steamId3'
      );
      const accountId = pick(
        u,
        'accountId','account_id',
        'user.accountId','user.account_id',
        'profile.accountId','profile.account_id',
        'steam.accountId','steam.account_id',
        'profile.account_id','steam.account_id'
      );

      const steam64 = toSteam64({ steam64: steam64Raw, steam2, steam3, accountId });

      return {
        name: String(name),
        id: String(id ?? i),
        uuid: String(uuid ?? ''),
        steam64: String(steam64 ?? '')
      };
    });

    const seen = new Set();
    const unique = [];
    for (const r of mapped) {
      const k = `${r.id}|${r.uuid}|${r.steam64}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(r);
    }
    const lines = unique.map(r => `name: ${r.name} | id: ${r.id} | uuid: ${r.uuid} | 64id: ${r.steam64}`);
    const text = lines.join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const fname = `ids-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.txt`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(text);
  } catch (e) {
    console.error('ids export error:', e);
    res.status(500).json({ error: 'ids_export_failed' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`listening on ${PORT}`));
