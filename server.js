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
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.adati.app.br/webhook/radar-local-leme';

const sessions = new Map();

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
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
  const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  parsed.clients ||= [];
  parsed.keywords ||= [];
  parsed.scans ||= [];
  return parsed;
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

function sanitizeGridSize(gridSize) {
  const n = Number(gridSize);
  return [3, 5, 7].includes(n) ? n : 5;
}

function sanitizeRadius(radiusKm) {
  const n = Number(radiusKm);
  if (!Number.isFinite(n)) return 3;
  return Math.min(Math.max(n, 0.2), 50);
}

function generateGrid(centerLat, centerLng, gridSize, radiusKm) {
  const safeGrid = sanitizeGridSize(gridSize);
  const safeRadius = sanitizeRadius(radiusKm);
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

function getSearchRadiusMeters(radiusKm, gridSize) {
  const radius = sanitizeRadius(radiusKm);
  const grid = sanitizeGridSize(gridSize);
  const stepKm = grid === 1 ? radius : (radius * 2) / (grid - 1);
  return Math.round(Math.min(Math.max(stepKm * 450, 500), 3000));
}

async function geocodeByPlaceId(placeId) {
  if (!GOOGLE_MAPS_BACKEND_KEY) return null;
  const cleanId = cleanPlaceId(placeId);
  if (!cleanId) return null;
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('place_id', cleanId);
  url.searchParams.set('key', GOOGLE_MAPS_BACKEND_KEY);
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('region', 'br');
  const response = await fetch(url);
  const json = await response.json();
  if (json.status !== 'OK' || !json.results?.[0]?.geometry?.location) return null;
  const loc = json.results[0].geometry.location;
  return {
    lat: loc.lat,
    lng: loc.lng,
    formattedAddress: json.results[0].formatted_address || '',
    source: 'place_id'
  };
}

async function geocodeByAddress(address, city) {
  if (!GOOGLE_MAPS_BACKEND_KEY) return null;
  const text = [address, city, 'Brasil'].filter(Boolean).join(', ');
  if (!text.trim()) return null;
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', text);
  url.searchParams.set('key', GOOGLE_MAPS_BACKEND_KEY);
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('region', 'br');
  const response = await fetch(url);
  const json = await response.json();
  if (json.status !== 'OK' || !json.results?.[0]?.geometry?.location) return null;
  const loc = json.results[0].geometry.location;
  return {
    lat: loc.lat,
    lng: loc.lng,
    formattedAddress: json.results[0].formatted_address || '',
    source: 'address'
  };
}

async function resolveCoordinates({ placeId, address, city, lat, lng }) {
  const manualLat = normalizeNumber(lat);
  const manualLng = normalizeNumber(lng);
  if (manualLat !== null && manualLng !== null) {
    return { lat: manualLat, lng: manualLng, source: 'manual', formattedAddress: address || '' };
  }

  const byPlace = await geocodeByPlaceId(placeId);
  if (byPlace) return byPlace;

  const byAddress = await geocodeByAddress(address, city);
  if (byAddress) return byAddress;

  throw new Error('Não foi possível descobrir latitude e longitude. Informe o endereço completo ou preencha as coordenadas em opções avançadas.');
}

async function searchPlacesAtPoint({ query, lat, lng, searchRadiusMeters = 1000, maxPages = 3 }) {
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
          radius: searchRadiusMeters
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
    appName: 'Radar Local LEME',
    webhookConfigured: Boolean(N8N_WEBHOOK_URL),
    webhookUrl: N8N_WEBHOOK_URL.replace(/\/webhook\/.+$/, '/webhook/...')
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

app.post('/api/clients', requireAuth, async (req, res) => {
  const db = readDb();

  if (!req.body.name || !req.body.placeId) {
    return res.status(400).json({ error: 'Preencha nome do cliente e Place ID.' });
  }

  let coords;
  try {
    coords = await resolveCoordinates(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const client = {
    id: id('cli'),
    name: String(req.body.name).trim(),
    city: String(req.body.city || '').trim(),
    specialty: String(req.body.specialty || '').trim(),
    address: String(req.body.address || coords.formattedAddress || '').trim(),
    placeId: cleanPlaceId(req.body.placeId),
    lat: Number(Number(coords.lat).toFixed(7)),
    lng: Number(Number(coords.lng).toFixed(7)),
    coordinateSource: coords.source,
    notes: String(req.body.notes || '').trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.clients.push(client);
  writeDb(db);
  res.json(client);
});

app.put('/api/clients/:id', requireAuth, async (req, res) => {
  const db = readDb();
  const index = db.clients.findIndex(c => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const current = db.clients[index];
  let coords = { lat: current.lat, lng: current.lng, source: current.coordinateSource || 'existing', formattedAddress: current.address };

  const wantsCoordinateUpdate = req.body.lat || req.body.lng || req.body.address || req.body.placeId;
  if (wantsCoordinateUpdate) {
    try {
      coords = await resolveCoordinates({ ...current, ...req.body });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  db.clients[index] = {
    ...current,
    name: String(req.body.name || current.name).trim(),
    city: String(req.body.city || '').trim(),
    specialty: String(req.body.specialty || '').trim(),
    address: String(req.body.address || coords.formattedAddress || '').trim(),
    placeId: cleanPlaceId(req.body.placeId || current.placeId),
    lat: Number(Number(coords.lat).toFixed(7)),
    lng: Number(Number(coords.lng).toFixed(7)),
    coordinateSource: coords.source,
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

  const gridSize = sanitizeGridSize(req.body.gridSize);
  const radiusKm = sanitizeRadius(req.body.radiusKm);
  const searchRadiusMeters = getSearchRadiusMeters(radiusKm, gridSize);
  const gridPoints = generateGrid(client.lat, client.lng, gridSize, radiusKm);
  const targetPlaceId = cleanPlaceId(client.placeId);
  const results = [];

  try {
    for (const point of gridPoints) {
      const placeIds = await searchPlacesAtPoint({
        query: keyword.term,
        lat: point.lat,
        lng: point.lng,
        searchRadiusMeters
      });
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
    clientCity: client.city,
    clientSpecialty: client.specialty,
    clientAddress: client.address,
    clientPlaceId: client.placeId,
    keywordId: keyword.id,
    keyword: keyword.term,
    gridSize,
    radiusKm,
    searchRadiusMeters,
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

app.post('/api/scans/:id/webhook', requireAuth, async (req, res) => {
  if (!N8N_WEBHOOK_URL) return res.status(400).json({ error: 'N8N_WEBHOOK_URL não configurado.' });

  const db = readDb();
  const scan = db.scans.find(s => s.id === req.params.id);
  if (!scan) return res.status(404).json({ error: 'Análise não encontrada.' });

  const client = db.clients.find(c => c.id === scan.clientId) || null;
  const imageDataUrl = String(req.body.imageDataUrl || '');
  if (!imageDataUrl.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'Imagem do relatório inválida.' });
  }

  const payload = {
    event: 'radar_local_leme_report',
    generatedAt: new Date().toISOString(),
    source: 'Radar Local LEME',
    client: client ? {
      id: client.id,
      name: client.name,
      city: client.city,
      specialty: client.specialty,
      address: client.address,
      placeId: client.placeId,
      lat: client.lat,
      lng: client.lng
    } : {
      id: scan.clientId,
      name: scan.clientName,
      city: scan.clientCity,
      specialty: scan.clientSpecialty,
      address: scan.clientAddress,
      placeId: scan.clientPlaceId,
      lat: scan.center.lat,
      lng: scan.center.lng
    },
    scan: {
      id: scan.id,
      keyword: scan.keyword,
      gridSize: scan.gridSize,
      radiusKm: scan.radiusKm,
      searchRadiusMeters: scan.searchRadiusMeters,
      center: scan.center,
      summary: scan.summary,
      points: scan.points,
      createdAt: scan.createdAt,
      note: scan.note
    },
    reportImage: {
      filename: `radar-local-${scan.clientName || 'cliente'}-${scan.keyword || 'keyword'}.png`.replace(/[^a-z0-9.-]+/gi, '-').toLowerCase(),
      mimeType: 'image/png',
      dataUrl: imageDataUrl,
      base64: imageDataUrl.replace(/^data:image\/png;base64,/, '')
    }
  };

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    if (!response.ok) {
      return res.status(502).json({ error: 'Webhook respondeu com erro.', status: response.status, detail: text.slice(0, 500) });
    }

    res.json({ ok: true, webhookStatus: response.status, webhookResponse: text.slice(0, 500) });
  } catch (error) {
    res.status(502).json({ error: 'Erro ao enviar para o webhook.', detail: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  ensureDb();
  console.log(`Radar Local LEME rodando na porta ${PORT}`);
});
