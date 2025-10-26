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
const UPLOAD_DIR = path.resolve('uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({ dest: path.join(UPLOAD_DIR, 'tmp') });

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: process.env.FRONTEND_ORIGIN || true }
});

const PORT = process.env.PORT || 8080;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const INTERVAL_CRON = process.env.AFFILIATE_CRON || '*/30 * * * *';

let leaderboard = [];
let updatedAt = null;

const CACHE_PATH = path.join(UPLOAD_DIR, 'leaderboard.json');

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


let prizes = [175, 100, 70, 50, 35, 25, 15, 10, 10, 10];
let countdownEnd = process.env.COUNTDOWN_END
  ? new Date(process.env.COUNTDOWN_END).toISOString()
  : null;
let announcement = process.env.ANNOUNCEMENT || '';

let hero = {
  headline: '$ 500 CSGOWIN WAGER LEADERBOARD',
  sub1: 'Top 10 players with the highest wagers past 2 weeks win a share of $500',

  sub2: 'The leaderboard updates every 30 minutes.',
  linkText: undefined,
  linkUrl: undefined,
  headlineColor: '#ffffff',
  sub1Color: '#cbd5e1',
  sub2Color: '#cbd5e1',
  headlineGlow: '0 0 12px rgba(255,255,255,0.8)',
  imageUrl: '/site-logo.png',
  imageScale: 1.0,
  imageGlow: 'drop-shadow(0 0 16px rgba(255,255,255,0.65))'
};

app.use(express.json());
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(
  cors({ origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN })
);

function sortPlayers(list) {
  return (Array.isArray(list) ? list : [])
    .map(x => ({ ...x, points: Number(x?.points) || 0 }))
    .sort((a, b) => b.points - a.points);
}
function isSane(list) {
  return Array.isArray(list) && list.length > 0;
}

async function refresh() {
  try {
    const players = await fetchAffiliate();
    const sorted = sortPlayers(players);

    if (isSane(sorted)) {
      leaderboard = sorted;
      updatedAt = new Date().toISOString();
      saveCache();
      io.emit('leaderboard:update', leaderboard);
      console.log(`[refresh] ok: ${leaderboard.length} players at ${updatedAt}`);
    } else {
      console.warn('[refresh] empty/invalid list; keeping last good cache');
    }
  } catch (err) {
    console.error('[refresh] failed:', err?.message || err);
  
  }
}

cron.schedule(INTERVAL_CRON, refresh);

setTimeout(() => { refresh().catch(()=>{}); }, 1500);

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    updatedAt,
    count: leaderboard.length
  });
});

app.get('/api/leaderboard', (req, res) => res.json(leaderboard));
app.get('/api/countdown', (req, res) => res.json({ end: countdownEnd }));
app.get('/api/announcement', (req, res) => res.json({ announcement }));
app.get('/api/prizes', (req, res) => res.json({ prizes }));
app.get('/api/hero', (req, res) => res.json(hero));

// Optional: metadata endpoint if you want it in the frontend later
app.get('/api/leaderboard/meta', (req, res) => {
  res.json({ updatedAt, count: leaderboard.length });
});

// ------------------ Admin helpers ------------------
function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token');
  if (!process.env.ADMIN_TOKEN) return res.status(404).json({ error: 'not_found' });
  if (token !== process.env.ADMIN_TOKEN) return res.status(404).json({ error: 'not_found' });
  next();
}
const adminLimiter = rateLimit({ windowMs: 60_000, max: 20 });

app.get('/api/admin/ping', adminLimiter, requireAdmin, (req, res) => {
  res.json({ ok: true });
});

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
    // allow "YYYY-MM-DD HH:mm:ss" without timezone
    const raw = t.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
      t = new Date(raw.replace(' ', 'T'));
    }
  }
  const dt = t instanceof Date ? t.getTime() : Date.parse(String(t || ''));
  if (!Number.isFinite(dt)) return res.status(400).json({ error: 'invalid end' });

  countdownEnd = new Date(dt).toISOString();
  io.emit('countdown:update', { end: countdownEnd });
  res.json({ end: countdownEnd });
});

app.post('/api/hero/image', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const finalPath = path.join(UPLOAD_DIR, 'hero' + path.extname(req.file.originalname || '.png'));
  fs.renameSync(req.file.path, finalPath);

  // public URL
  const publicUrl = '/uploads/' + path.basename(finalPath);
  hero.imageUrl = publicUrl;
  io.emit('hero:update', hero);

  res.json({ imageUrl: publicUrl });
});

app.post('/api/announcement', requireAdmin, (req, res) => {
  announcement = req.body?.announcement || '';
  io.emit('announcement:update', { announcement });
  res.json({ announcement });
});

app.post('/api/hero', requireAdmin, (req, res) => {
  const {
    headline, sub1, sub2,
    linkText, linkUrl,
    headlineColor, sub1Color, sub2Color,
    headlineGlow, imageUrl, imageGlow, 
    imageScale
  } = req.body || {};

  hero = {
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
    imageScale: typeof imageScale === 'number' ? imageScale : hero.imageScale,
  };

  io.emit('hero:update', hero);
  res.json(hero);
});

app.post('/api/admin/refresh', requireAdmin, async (req, res) => {
  await refresh();
  res.json({ ok: true, count: leaderboard.length, updatedAt });
});

// -------- IDs export helper (unchanged except filename fix) --------
app.get('/api/ids', requireAdmin, async (req, res) => {
  try {
    const raw = await fetchAffiliateRaw();
    const list = Array.isArray(raw) ? raw : [];

    const pick = (obj, ...paths) => {
      for (const p of paths) {
        let cur = obj;
        for (const seg of String(p).split('.')) {
          if (cur && Object.prototype.hasOwnProperty.call(cur, seg)) {
            cur = cur[seg];
          } else {
            cur = undefined;
            break;
          }
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
        try {
          const n = BigInt(s);
          if (n >= BASE64) return n.toString();
        } catch {}
      }
      if (steam2) {
        const s = String(steam2).trim();
        const m = /^STEAM_[0-5]:([01]):(\d+)$/.exec(s);
        if (m) {
          const acct = BigInt(m[2]);
          const universe = BigInt(m[1]);
          // universe is not needed for accountId → 64 conversion here
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
        try {
          const a = BigInt(String(accountId).trim());
          return (BASE64 + a).toString();
        } catch {}
      }
      return '';
    }

    const mapped = list.map((u, i) => {
      const name = pick(
        u,
        'name','username','displayName',
        'user.name','user.username','user.displayName',
        'profile.name','profile.username','profile.displayName'
      ) ?? `Player ${i + 1}`;

      const id = pick(
        u,
        'id','uuid','user_id','userId','userID','user','account_id',
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
    const lines = unique.map(r =>
      `name: ${r.name} | id: ${r.id} | uuid: ${r.uuid} | 64id: ${r.steam64}`
    );
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
