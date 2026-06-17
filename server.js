const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const APP_USER = process.env.APP_USER || 'leme';
const APP_PASSWORD = process.env.APP_PASSWORD || 'leme123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const GOOGLE_MAPS_FRONTEND_KEY = process.env.GOOGLE_MAPS_FRONTEND_KEY || '';
const GOOGLE_MAPS_BACKEND_KEY = process.env.GOOGLE_MAPS_BACKEND_KEY || '';

const sessions = new Map();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial = { clients: [], keywords: [], scans: [], createdAt: new Date().toISOString() };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  if (!found) return null;
  return decodeURIComponent(found.split('=').slice(1).join('='));
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function makeSessionCookie(sessionId) {
  const value = `${sessionId}.${sign(sessionId)}`;
  return `radar_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 7}`;
}

function clearSessionCookie() {
  return `radar_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function getSession(req) {
  const raw = getCookie(req, 'radar_session');
  if (!raw) return null;
  const [sessionId, signature] = raw.split('.');
  if (!sessionId || !signature) return null;
  if (sign(sessionId) !== signature) return null;
  return sessions.get(sessionId) || null;
}

function requireAuth(req, res, next) {
  if (getSession(req)) return next();
  return res.status(401).json({ error: 'Não autenticado' });
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function generateGrid(centerLat, centerLng, gridSize, radiusKm) {
  const safeGrid = [3, 5].includes(Number(gridSize)) ? Number(gridSize) : 5;
  const safeRadius = Math.min(Math.max(Number(radiusKm) || 3, 0.5), 10);
  const centerIndex = Math.floor(safeGrid / 2);
  const stepKm = safeGrid === 1 ? 0 : (safeRadius * 2) / (safeGrid - 1);
  const points = [];

  for (let row = 0; row < safeGrid; row++) {
    for (let col = 0; col < safeGrid; col++) {
      const northKm = (centerIndex - row) * stepKm;
      const eastKm = (col - centerIndex) * stepKm;
      const lat = centerLat + (northKm / 111.32);
      const lng = centerLng + (eastKm / (111.32 * Math.cos(centerLat * Math.PI / 180)));
      points.push({
        row,
        col,
        lat: Number(lat.toFixed(7)),
        lng: Number(lng.toFixed(7)),
        distanceFromCenterKm: Number(haversineKm({ lat: centerLat, lng: centerLng }, { lat, lng }).toFixed(2))
      });
    }
  }

  return points;
}

function cleanPlaceId(placeId) {
  if (!placeId) return '';
  return String(placeId).trim().replace(/^places\//, '');
}

function rankColor(position) {
  if (!position) return 'gray';
  if (position <= 3) return 'green';
  if (position <= 10) return 'yellow';
  return 'red';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchPlacesAtPoint({ query, lat, lng, maxPages = 3 }) {
  if (!GOOGLE_MAPS_BACKEND_KEY) {
    throw new Error('GOOGLE_MAPS_BACKEND_KEY não configurada no servidor.');
  }

  const endpoint = 'https://places.googleapis.com/v1/places:searchText';
  let pageToken = null;
  const placeIds = [];

  for (let page = 0; page < maxPages; page++) {
    const body = {
      textQuery: query,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      pageSize: 20,
      locationBias: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: 1000
        }
      }
    };

    if (pageToken) body.pageToken = pageToken;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_BACKEND_KEY,
        'X-Goog-FieldMask': 'places.id,nextPageToken'
      },
      body: JSON.stringify(body)
    });

    const json = await response.json();

    if (!response.ok) {
      const message = json?.error?.message || 'Erro ao consultar Places API';
      throw new Error(message);
    }

    const ids = (json.places || []).map(place => cleanPlaceId(place.id)).filter(Boolean);
    placeIds.push(...ids);

    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
    await sleep(1800);
  }

  return placeIds;
}

function summarizeScan(points) {
  const validPositions = points.map(p => p.position).filter(Boolean);
  const total = points.length || 1;
  const top3 = points.filter(p => p.position && p.position <= 3).length;
  const top10 = points.filter(p => p.position && p.position <= 10).length;
  const notFound = points.filter(p => !p.position).length;
  const avg = validPositions.length
    ? validPositions.reduce((sum, n) => sum + n, 0) / validPositions.length
    : null;

  return {
    totalPoints: points.length,
    averagePosition: avg ? Number(avg.toFixed(2)) : null,
    top3Percent: Number(((top3 / total) * 100).toFixed(1)),
    top10Percent: Number(((top10 / total) * 100).toFixed(1)),
    notFoundPercent: Number(((notFound / total) * 100).toFixed(1)),
    foundPoints: validPositions.length,
    notFoundPoints: notFound,
    bestPosition: validPositions.length ? Math.min(...validPositions) : null,
    worstPosition: validPositions.length ? Math.max(...validPositions) : null
  };
}

app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    googleMapsFrontendKey: GOOGLE_MAPS_FRONTEND_KEY,
    appName: 'Radar Local LEME'
  });
});

app.post('/api/login', (req, res) => {
  const { user, password } = req.body;
  if (user === APP_USER && password === APP_PASSWORD) {
    const sessionId = crypto.randomBytes(24).toString('hex');
    sessions.set(sessionId, { user, createdAt: new Date().toISOString() });
    res.setHeader('Set-Cookie', makeSessionCookie(sessionId));
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Usuário ou senha inválidos' });
});

app.post('/api/logout', (req, res) => {
  const raw = getCookie(req, 'radar_session');
  if (raw) {
    const [sessionId] = raw.split('.');
    sessions.delete(sessionId);
  }
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Não autenticado' });
  res.json({ user: session.user });
});

app.get('/api/clients', requireAuth, (req, res) => {
  const db = readDb();
  res.json(db.clients.sort((a, b) => a.name.localeCompare(b.name)));
});

app.post('/api/clients', requireAuth, (req, res) => {
  const db = readDb();
  const lat = normalizeNumber(req.body.lat);
  const lng = normalizeNumber(req.body.lng);

  if (!req.body.name || !req.body.placeId || lat === null || lng === null) {
    return res.status(400).json({ error: 'Preencha nome, Place ID, latitude e longitude.' });
  }

  const client = {
    id: id('cli'),
    name: String(req.body.name).trim(),
    city: String(req.body.city || '').trim(),
    specialty: String(req.body.specialty || '').trim(),
    address: String(req.body.address || '').trim(),
    placeId: cleanPlaceId(req.body.placeId),
    lat,
    lng,
    notes: String(req.body.notes || '').trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.clients.push(client);
  writeDb(db);
  res.json(client);
});

app.put('/api/clients/:id', requireAuth, (req, res) => {
  const db = readDb();
  const index = db.clients.findIndex(c => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const current = db.clients[index];
  const lat = normalizeNumber(req.body.lat);
  const lng = normalizeNumber(req.body.lng);

  db.clients[index] = {
    ...current,
    name: String(req.body.name || current.name).trim(),
    city: String(req.body.city || '').trim(),
    specialty: String(req.body.specialty || '').trim(),
    address: String(req.body.address || '').trim(),
    placeId: cleanPlaceId(req.body.placeId || current.placeId),
    lat: lat === null ? current.lat : lat,
    lng: lng === null ? current.lng : lng,
    notes: String(req.body.notes || '').trim(),
    updatedAt: new Date().toISOString()
  };

  writeDb(db);
  res.json(db.clients[index]);
});

app.delete('/api/clients/:id', requireAuth, (req, res) => {
  const db = readDb();
  db.clients = db.clients.filter(c => c.id !== req.params.id);
  db.keywords = db.keywords.filter(k => k.clientId !== req.params.id);
  db.scans = db.scans.filter(s => s.clientId !== req.params.id);
  writeDb(db);
  res.json({ ok: true });
});

app.get('/api/keywords', requireAuth, (req, res) => {
  const db = readDb();
  const clientId = req.query.clientId;
  const keywords = clientId ? db.keywords.filter(k => k.clientId === clientId) : db.keywords;
  res.json(keywords.sort((a, b) => a.term.localeCompare(b.term)));
});

app.post('/api/keywords', requireAuth, (req, res) => {
  const db = readDb();
  const client = db.clients.find(c => c.id === req.body.clientId);
  if (!client) return res.status(400).json({ error: 'Cliente inválido.' });
  if (!req.body.term) return res.status(400).json({ error: 'Informe a palavra-chave.' });

  const keyword = {
    id: id('kw'),
    clientId: client.id,
    term: String(req.body.term).trim(),
    createdAt: new Date().toISOString()
  };
  db.keywords.push(keyword);
  writeDb(db);
  res.json(keyword);
});

app.delete('/api/keywords/:id', requireAuth, (req, res) => {
  const db = readDb();
  db.keywords = db.keywords.filter(k => k.id !== req.params.id);
  writeDb(db);
  res.json({ ok: true });
});

app.get('/api/scans', requireAuth, (req, res) => {
  const db = readDb();
  const clientId = req.query.clientId;
  const scans = clientId ? db.scans.filter(s => s.clientId === clientId) : db.scans;
  res.json(scans.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.get('/api/scans/:id', requireAuth, (req, res) => {
  const db = readDb();
  const scan = db.scans.find(s => s.id === req.params.id);
  if (!scan) return res.status(404).json({ error: 'Análise não encontrada.' });
  res.json(scan);
});

app.post('/api/scans/run', requireAuth, async (req, res) => {
  const db = readDb();
  const client = db.clients.find(c => c.id === req.body.clientId);
  const keyword = db.keywords.find(k => k.id === req.body.keywordId && k.clientId === req.body.clientId);

  if (!client) return res.status(400).json({ error: 'Cliente inválido.' });
  if (!keyword) return res.status(400).json({ error: 'Palavra-chave inválida.' });

  const gridSize = [3, 5].includes(Number(req.body.gridSize)) ? Number(req.body.gridSize) : 5;
  const radiusKm = Math.min(Math.max(Number(req.body.radiusKm) || 3, 0.5), 10);
  const gridPoints = generateGrid(client.lat, client.lng, gridSize, radiusKm);
  const targetPlaceId = cleanPlaceId(client.placeId);
  const results = [];

  try {
    for (const point of gridPoints) {
      const placeIds = await searchPlacesAtPoint({ query: keyword.term, lat: point.lat, lng: point.lng });
      const index = placeIds.findIndex(placeId => placeId === targetPlaceId);
      const position = index === -1 ? null : index + 1;

      results.push({
        ...point,
        position,
        color: rankColor(position),
        checkedResults: placeIds.length,
        checkedAt: new Date().toISOString()
      });
    }
  } catch (error) {
    return res.status(500).json({
      error: 'Erro ao rodar análise no Google Places.',
      detail: error.message
    });
  }

  const scan = {
    id: id('scan'),
    clientId: client.id,
    clientName: client.name,
    keywordId: keyword.id,
    keyword: keyword.term,
    gridSize,
    radiusKm,
    center: { lat: client.lat, lng: client.lng },
    points: results,
    summary: summarizeScan(results),
    createdAt: new Date().toISOString(),
    note: 'Resultado gerado por busca geolocalizada via Google Places. Trate como fotografia do momento.'
  };

  db.scans.push(scan);
  writeDb(db);
  res.json(scan);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  ensureDb();
  console.log(`Radar Local LEME rodando na porta ${PORT}`);
});
