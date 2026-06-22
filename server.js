const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const ASSETS_DIR = path.join(__dirname, 'public', 'assets');

const APP_USER = process.env.APP_USER || 'leme';
const APP_PASSWORD = process.env.APP_PASSWORD || 'leme123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const GOOGLE_MAPS_FRONTEND_KEY = process.env.GOOGLE_MAPS_FRONTEND_KEY || '';
const GOOGLE_MAPS_BACKEND_KEY = process.env.GOOGLE_MAPS_BACKEND_KEY || '';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.adati.app.br/webhook/radar-local-leme';
const AUTOMATION_TOKEN = process.env.AUTOMATION_TOKEN || 'troque-este-token';
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'https://maps.sistemaleme.com.br/api/google/callback';
const GOOGLE_INSIGHTS_SCOPES = process.env.GOOGLE_INSIGHTS_SCOPES || process.env.GOOGLE_GBP_SCOPES || 'https://www.googleapis.com/auth/business.manage';
const TOKEN_ENCRYPTION_SECRET = process.env.TOKEN_ENCRYPTION_SECRET || SESSION_SECRET;

const sessions = new Map();
const runningJobs = new Map();

app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ extended: true, limit: '35mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function defaultSettings() {
  return {
    n8nResultWebhookUrl: N8N_WEBHOOK_URL,
    defaultGridSize: 5,
    defaultRadiusKm: 3,
    defaultTheme: 'dark',
    agencyName: 'LEME Marketing Médico',
    reportFooter: 'Relatório gerado por busca geolocalizada via Google Places. Use como fotografia estratégica do momento, acompanhando evolução mês a mês.',
    reportTitle: 'Relatório de Desempenho Local'
  };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ clients: [], keywords: [], scans: [], jobs: [], settings: defaultSettings(), createdAt: new Date().toISOString() }, null, 2));
  }
}

function readDb() {
  ensureDb();
  const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  parsed.clients ||= [];
  parsed.keywords ||= [];
  parsed.scans ||= [];
  parsed.jobs ||= [];
  parsed.insightsProfiles ||= [];
  parsed.insightsReports ||= [];
  parsed.insightsGoogle ||= { token: null, connectedEmail: '', connectedAt: null, updatedAt: null };
  parsed.settings = { ...defaultSettings(), ...(parsed.settings || {}) };
  return parsed;
}

function writeDb(db) {
  ensureDb();
  db.settings = { ...defaultSettings(), ...(db.settings || {}) };
  // Backup automático antes de cada alteração, para evitar perda de clientes/análises em atualizações futuras.
  try {
    if (fs.existsSync(DB_PATH)) {
      const backupDir = path.join(DATA_DIR, 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(DB_PATH, path.join(backupDir, `db-${stamp}.json`));
      const backups = fs.readdirSync(backupDir)
        .filter(name => name.startsWith('db-') && name.endsWith('.json'))
        .sort()
        .reverse();
      backups.slice(30).forEach(name => fs.unlinkSync(path.join(backupDir, name)));
    }
  } catch (error) {
    console.warn('Não foi possível criar backup automático do banco:', error.message);
  }
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

function makeSessionCookie(user) {
  const payload = Buffer.from(JSON.stringify({ user, createdAt: new Date().toISOString() })).toString('base64url');
  const value = `${payload}.${sign(payload)}`;
  return `radar_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 7}`;
}

function clearSessionCookie() {
  return `radar_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function getSession(req) {
  const raw = getCookie(req, 'radar_session');
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;
  if (sign(payload) !== signature) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (!session?.user) return null;
    return session;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  if (getSession(req)) return next();
  return res.status(401).json({ error: 'Não autenticado' });
}

function requireAutomationToken(req, res, next) {
  const token = req.headers['x-automation-token'] || req.query.token || req.body?.token;
  if (token && String(token) === AUTOMATION_TOKEN) return next();
  return res.status(401).json({ error: 'Token de automação inválido.' });
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function sanitizeGridSize(gridSize) {
  const n = Number(gridSize);
  return [3, 5, 7].includes(n) ? n : 5;
}

function sanitizeRadius(radiusKm) {
  const n = Number(String(radiusKm).replace(',', '.'));
  if (!Number.isFinite(n)) return 3;
  return Math.min(Math.max(n, 0.2), 50);
}

function cleanPlaceId(placeId) {
  if (!placeId) return '';
  return String(placeId).trim().replace(/^places\//, '');
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
  return { lat: loc.lat, lng: loc.lng, formattedAddress: json.results[0].formatted_address || '', source: 'place_id' };
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
  return { lat: loc.lat, lng: loc.lng, formattedAddress: json.results[0].formatted_address || '', source: 'address' };
}

async function resolveCoordinates({ placeId, address, city, profileLat, profileLng, lat, lng }) {
  const manualLat = normalizeNumber(profileLat ?? lat);
  const manualLng = normalizeNumber(profileLng ?? lng);
  if (manualLat !== null && manualLng !== null) return { lat: manualLat, lng: manualLng, source: 'manual', formattedAddress: address || '' };
  const byPlace = await geocodeByPlaceId(placeId);
  if (byPlace) return byPlace;
  const byAddress = await geocodeByAddress(address, city);
  if (byAddress) return byAddress;
  throw new Error('Não foi possível descobrir latitude e longitude. Informe o endereço completo ou preencha as coordenadas em opções avançadas.');
}

async function searchPlacesAtPoint({ query, lat, lng, searchRadiusMeters = 1000, maxPages = 3, includeNames = false }) {
  if (!GOOGLE_MAPS_BACKEND_KEY) throw new Error('GOOGLE_MAPS_BACKEND_KEY não configurada no servidor.');
  const endpoint = 'https://places.googleapis.com/v1/places:searchText';
  let pageToken = null;
  const places = [];
  const fieldMask = includeNames ? 'places.id,places.displayName,nextPageToken' : 'places.id,nextPageToken';
  for (let page = 0; page < maxPages; page++) {
    const body = {
      textQuery: query,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      pageSize: 20,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: searchRadiusMeters } }
    };
    if (pageToken) body.pageToken = pageToken;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_BACKEND_KEY,
        'X-Goog-FieldMask': fieldMask
      },
      body: JSON.stringify(body)
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json?.error?.message || 'Erro ao consultar Places API');
    for (const place of (json.places || [])) {
      const placeId = cleanPlaceId(place.id);
      if (!placeId) continue;
      places.push({
        id: placeId,
        name: includeNames ? (place.displayName?.text || place.displayName || '') : ''
      });
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
    await sleep(1800);
  }
  return places;
}

function summarizeCompetitors(competitorMap, totalPoints) {
  const items = Array.from(competitorMap.entries()).map(([placeId, data]) => {
    const avg = data.positions.length ? data.positions.reduce((sum, n) => sum + n, 0) / data.positions.length : null;
    const top10 = data.positions.filter(n => n <= 10).length;
    return {
      placeId,
      name: data.name || 'Perfil sem nome',
      averagePosition: avg ? Number(avg.toFixed(2)) : null,
      bestPosition: data.positions.length ? Math.min(...data.positions) : null,
      worstPosition: data.positions.length ? Math.max(...data.positions) : null,
      appearances: data.positions.length,
      totalPoints,
      appearancesPercent: Number(((data.positions.length / Math.max(totalPoints, 1)) * 100).toFixed(1)),
      top10Percent: Number(((top10 / Math.max(totalPoints, 1)) * 100).toFixed(1)),
      isTarget: Boolean(data.isTarget)
    };
  }).sort((a, b) => (a.averagePosition ?? 999) - (b.averagePosition ?? 999) || b.appearances - a.appearances || String(a.name).localeCompare(String(b.name)));

  const target = items.find(item => item.isTarget);
  const topItems = items.slice(0, 30);
  if (target && !topItems.some(item => item.placeId === target.placeId)) {
    topItems.pop();
    topItems.push(target);
    topItems.sort((a, b) => (a.averagePosition ?? 999) - (b.averagePosition ?? 999) || b.appearances - a.appearances || String(a.name).localeCompare(String(b.name)));
  }
  return topItems;
}

function summarizeScan(points) {
  const validPositions = points.map(p => p.position).filter(Boolean);
  const total = points.length || 1;
  const top3 = points.filter(p => p.position && p.position <= 3).length;
  const top10 = points.filter(p => p.position && p.position <= 10).length;
  const notFound = points.filter(p => !p.position).length;
  const avg = validPositions.length ? validPositions.reduce((sum, n) => sum + n, 0) / validPositions.length : null;
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

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function slug(value) {
  return String(value || 'radar-local-leme')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/(^-|-$)/g, '').toLowerCase();
}

function readAssetBase64(fileName) {
  const filePath = path.join(ASSETS_DIR, fileName);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath).toString('base64');
}

function latLngToWorld(lat, lng) {
  const siny = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI);
  const x = (lng + 180) / 360;
  return { x: x * 256, y: y * 256 };
}

function pointToPixel(point, center, zoom, width, height) {
  const scale = Math.pow(2, zoom);
  const worldCenter = latLngToWorld(center.lat, center.lng);
  const worldPoint = latLngToWorld(point.lat, point.lng);
  return {
    x: width / 2 + (worldPoint.x - worldCenter.x) * scale,
    y: height / 2 + (worldPoint.y - worldCenter.y) * scale
  };
}

function chooseZoom(points, center, width, height) {
  for (let zoom = 18; zoom >= 4; zoom--) {
    const coords = points.map(p => pointToPixel(p, center, zoom, width, height));
    const margin = 42;
    const fits = coords.every(p => p.x >= margin && p.x <= width - margin && p.y >= margin && p.y <= height - margin);
    if (fits) return zoom;
  }
  return 10;
}

async function getStaticMapDataUri(scan, logicalW, logicalH) {
  if (!GOOGLE_MAPS_BACKEND_KEY) {
    throw new Error('GOOGLE_MAPS_BACKEND_KEY não configurada.');
  }
  const center = scan.center;
  const zoom = chooseZoom(scan.points, center, logicalW, logicalH);
  const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
  url.searchParams.set('center', `${center.lat},${center.lng}`);
  url.searchParams.set('zoom', String(zoom));
  url.searchParams.set('size', `${logicalW}x${logicalH}`);
  url.searchParams.set('scale', '2');
  url.searchParams.set('maptype', 'roadmap');
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('region', 'br');
  url.searchParams.set('key', GOOGLE_MAPS_BACKEND_KEY);
  const styles = [
    'feature:poi|visibility:off',
    'feature:transit|visibility:off',
    'feature:administrative.land_parcel|visibility:off',
    'feature:poi.business|visibility:off',
    'feature:poi.park|element:labels|visibility:off'
  ];
  styles.forEach(style => url.searchParams.append('style', style));

  const response = await fetch(url.toString());
  const contentType = response.headers.get('content-type') || '';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!response.ok || !contentType.includes('image')) {
    const detail = buffer.toString('utf-8').slice(0, 220);
    throw new Error(`Maps Static API não retornou mapa real. Verifique se a API está ativada e permitida na chave Backend. ${detail}`);
  }
  if (buffer.length < 5000) {
    throw new Error('Maps Static API retornou imagem pequena demais. Verifique faturamento, API e restrições da chave Backend.');
  }

  // A Static Maps API trabalha com zoom inteiro. Para deixar o grid grande sem cortar,
  // baixamos o mapa em um zoom seguro e recortamos ao redor dos pontos do grid.
  const coords = scan.points.map(p => pointToPixel(p, center, zoom, logicalW, logicalH));
  const minX = Math.min(...coords.map(p => p.x));
  const maxX = Math.max(...coords.map(p => p.x));
  const minY = Math.min(...coords.map(p => p.y));
  const maxY = Math.max(...coords.map(p => p.y));
  const bboxW = Math.max(1, maxX - minX);
  const bboxH = Math.max(1, maxY - minY);
  const aspect = logicalW / logicalH;
  const desiredMargin = 34;

  let cropW = bboxW + desiredMargin * 2;
  let cropH = bboxH + desiredMargin * 2;
  if (cropW / cropH > aspect) cropH = cropW / aspect;
  else cropW = cropH * aspect;

  // Não deixe o recorte ficar maior que o mapa original, mas mantenha o grid perto do tamanho desejado.
  cropW = Math.min(logicalW, Math.max(cropW, logicalW * 0.48));
  cropH = Math.min(logicalH, Math.max(cropH, logicalH * 0.48));
  if (cropW / cropH > aspect) cropW = cropH * aspect;
  else cropH = cropW / aspect;

  const bboxCenterX = (minX + maxX) / 2;
  const bboxCenterY = (minY + maxY) / 2;
  let cropX = bboxCenterX - cropW / 2;
  let cropY = bboxCenterY - cropH / 2;
  cropX = Math.max(0, Math.min(logicalW - cropW, cropX));
  cropY = Math.max(0, Math.min(logicalH - cropH, cropY));

  const scale = 2;
  const crop = {
    left: Math.round(cropX * scale),
    top: Math.round(cropY * scale),
    width: Math.max(1, Math.round(cropW * scale)),
    height: Math.max(1, Math.round(cropH * scale))
  };
  const resized = await sharp(buffer)
    .extract(crop)
    .resize(logicalW * scale, logicalH * scale, { fit: 'fill' })
    .png()
    .toBuffer();

  return {
    dataUri: `data:image/png;base64,${resized.toString('base64')}`,
    zoom,
    logicalW,
    logicalH,
    cropX,
    cropY,
    cropW,
    cropH
  };
}

function truncateText(value, max = 90) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function reportFont() {
  return 'DejaVu Sans, Arial, sans-serif';
}

function labelFontSize(text, base = 28) {
  const len = String(text || '').length;
  if (len > 34) return Math.max(20, base - 12);
  if (len > 26) return Math.max(22, base - 8);
  if (len > 18) return Math.max(24, base - 4);
  return base;
}

function fallbackMapSvg(scan, mapW, mapH) {
  return `<rect x="0" y="0" width="${mapW}" height="${mapH}" fill="#eef4fb"/>
  <rect x="32" y="32" width="${mapW - 64}" height="${mapH - 64}" rx="22" fill="#ffffff" stroke="#d6e3f0" stroke-width="2"/>
  <text x="${mapW / 2}" y="${mapH / 2 - 18}" text-anchor="middle" fill="#163f73" font-size="30" font-weight="900" font-family="${reportFont()}">Mapa real indisponível</text>
  <text x="${mapW / 2}" y="${mapH / 2 + 24}" text-anchor="middle" fill="#65758b" font-size="22" font-family="${reportFont()}">Ative a Maps Static API e libere a chave Backend.</text>`;
}

function cryptoKey() {
  return crypto.createHash('sha256').update(String(TOKEN_ENCRYPTION_SECRET || SESSION_SECRET)).digest();
}

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decryptJson(value) {
  if (!value) return null;
  const raw = Buffer.from(value, 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function getStoredGoogleToken() {
  const db = readDb();
  try {
    return db.insightsGoogle?.token ? decryptJson(db.insightsGoogle.token) : null;
  } catch (error) {
    console.warn('Falha ao descriptografar token Google:', error.message);
    return null;
  }
}

function saveGoogleToken(token, email = '') {
  const db = readDb();
  db.insightsGoogle ||= {};
  db.insightsGoogle.token = encryptJson(token);
  if (email) db.insightsGoogle.connectedEmail = email;
  db.insightsGoogle.connectedAt ||= new Date().toISOString();
  db.insightsGoogle.updatedAt = new Date().toISOString();
  writeDb(db);
}

async function refreshGoogleTokenIfNeeded() {
  let token = getStoredGoogleToken();
  if (!token) throw new Error('Conta Google ainda não conectada.');
  const expiresAt = Number(token.expires_at || 0);
  if (token.access_token && expiresAt > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw new Error('Token expirado e sem refresh_token. Conecte a conta Google novamente.');
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || 'Falha ao renovar token Google.');
  token = { ...token, ...data, expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 };
  saveGoogleToken(token);
  return token.access_token;
}

async function googleJson(url, options = {}) {
  const accessToken = await refreshGoogleTokenIfNeeded();
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data.error?.message || data.error_description || data.error || `Erro Google ${response.status}`;
    throw new Error(msg);
  }
  return data;
}

async function getGoogleUserInfo(accessToken) {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return {};
    return await response.json();
  } catch {
    return {};
  }
}

function addressToText(address) {
  if (!address) return '';
  if (typeof address === 'string') return address;
  const parts = [];
  if (address.addressLines?.length) parts.push(address.addressLines.join(', '));
  if (address.locality) parts.push(address.locality);
  if (address.administrativeArea) parts.push(address.administrativeArea);
  if (address.postalCode) parts.push(address.postalCode);
  return parts.filter(Boolean).join(' - ');
}

async function listInsightsAccounts() {
  const data = await googleJson('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  return data.accounts || [];
}

async function listInsightsLocations() {
  const accounts = await listInsightsAccounts();
  const locations = [];
  for (const account of accounts) {
    let pageToken = '';
    do {
      const url = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`);
      url.searchParams.set('readMask', 'name,title,storefrontAddress,metadata');
      url.searchParams.set('pageSize', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = await googleJson(url.toString());
      (data.locations || []).forEach(location => {
        locations.push({
          accountName: account.name,
          accountDisplayName: account.accountName || account.name,
          name: location.name,
          title: location.title || location.name,
          address: addressToText(location.storefrontAddress),
          placeId: location.metadata?.placeId || '',
          mapsUri: location.metadata?.mapsUri || ''
        });
      });
      pageToken = data.nextPageToken || '';
    } while (pageToken);
  }
  return locations;
}

function dateParts(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida.');
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function extractDatedValues(timeSeries) {
  const values = timeSeries?.datedValues || timeSeries?.timeSeries?.datedValues || [];
  return values.map(item => ({
    date: `${item.date?.year || ''}-${String(item.date?.month || '').padStart(2, '0')}-${String(item.date?.day || '').padStart(2, '0')}`,
    value: Number(item.value || 0)
  })).filter(v => v.date && Number.isFinite(v.value));
}

function parsePerformanceResponse(data) {
  const metrics = {};
  const series = data.multiDailyMetricTimeSeries || [];
  for (const multi of series) {
    for (const entry of (multi.dailyMetricTimeSeries || [])) {
      const metric = entry.dailyMetric || 'UNKNOWN';
      const values = extractDatedValues(entry.timeSeries ? entry : entry);
      metrics[metric] ||= { total: 0, values: [] };
      values.forEach(v => {
        metrics[metric].values.push(v);
        metrics[metric].total += v.value;
      });
    }
  }
  Object.values(metrics).forEach(m => m.total = Number(m.total || 0));
  return metrics;
}

function sumMetrics(metrics, names) {
  return names.reduce((sum, name) => sum + Number(metrics[name]?.total || 0), 0);
}

async function fetchInsightsMetrics(locationName, startDate, endDate) {
  const start = dateParts(startDate);
  const end = dateParts(endDate);
  const metrics = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'BUSINESS_DIRECTION_REQUESTS',
    'CALL_CLICKS',
    'WEBSITE_CLICKS'
  ];
  const safeLocation = String(locationName).replace(/^locations\//, 'locations/');
  const url = new URL(`https://businessprofileperformance.googleapis.com/v1/${safeLocation}:fetchMultiDailyMetricsTimeSeries`);
  metrics.forEach(metric => url.searchParams.append('dailyMetrics', metric));
  url.searchParams.set('dailyRange.start_date.year', String(start.year));
  url.searchParams.set('dailyRange.start_date.month', String(start.month));
  url.searchParams.set('dailyRange.start_date.day', String(start.day));
  url.searchParams.set('dailyRange.end_date.year', String(end.year));
  url.searchParams.set('dailyRange.end_date.month', String(end.month));
  url.searchParams.set('dailyRange.end_date.day', String(end.day));
  const data = await googleJson(url.toString());
  return parsePerformanceResponse(data);
}

function insightsSummary(metrics) {
  const impressionsSearch = sumMetrics(metrics, ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH']);
  const impressionsMaps = sumMetrics(metrics, ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS']);
  const totalImpressions = impressionsSearch + impressionsMaps;
  const calls = sumMetrics(metrics, ['CALL_CLICKS']);
  const directions = sumMetrics(metrics, ['BUSINESS_DIRECTION_REQUESTS']);
  const website = sumMetrics(metrics, ['WEBSITE_CLICKS']);
  const totalInteractions = calls + directions + website;
  return {
    impressionsSearch,
    impressionsMaps,
    totalImpressions,
    mobileSearch: Number(metrics.BUSINESS_IMPRESSIONS_MOBILE_SEARCH?.total || 0),
    desktopSearch: Number(metrics.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH?.total || 0),
    mobileMaps: Number(metrics.BUSINESS_IMPRESSIONS_MOBILE_MAPS?.total || 0),
    desktopMaps: Number(metrics.BUSINESS_IMPRESSIONS_DESKTOP_MAPS?.total || 0),
    calls,
    directions,
    website,
    totalInteractions
  };
}

async function buildInsightsReportPng(report) {
  const W = 1600, H = 2000;
  const font = reportFont();
  const logoWhite = readAssetBase64('logo-horizontal-white.png');
  const s = report.summary || {};
  const logo = logoWhite ? `<image href="data:image/png;base64,${logoWhite}" x="70" y="58" width="230" preserveAspectRatio="xMinYMid meet"/>` : `<text x="70" y="105" fill="#fff" font-size="46" font-weight="900" font-family="${font}">LEME</text>`;
  const card = (x, y, w, h, label, value) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="#ffffff" stroke="#d8e4f1" stroke-width="2"/><text x="${x+28}" y="${y+48}" fill="#6b7b90" font-size="24" font-weight="800" font-family="${font}">${escapeXml(label)}</text><text x="${x+28}" y="${y+122}" fill="#1b4383" font-size="66" font-weight="900" font-family="${font}">${escapeXml(value ?? 0)}</text>`;
  const maxImp = Math.max(1, s.mobileSearch || 0, s.desktopSearch || 0, s.mobileMaps || 0, s.desktopMaps || 0);
  const bar = (label, value, y, color) => { const w = Math.max(8, Math.round((value / maxImp) * 650)); return `<text x="90" y="${y+25}" fill="#24344c" font-size="25" font-weight="800" font-family="${font}">${escapeXml(label)}</text><rect x="420" y="${y}" width="650" height="34" rx="17" fill="#e9f0f7"/><rect x="420" y="${y}" width="${w}" height="34" rx="17" fill="${color}"/><text x="1100" y="${y+26}" fill="#24344c" font-size="25" font-weight="900" font-family="${font}">${value}</text>`; };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#f6f8fc"/>
    <rect x="40" y="35" width="1520" height="150" rx="30" fill="#173b73"/>
    ${logo}
    <text x="1510" y="92" text-anchor="end" fill="#ffffff" font-size="42" font-weight="900" font-family="${font}">Insights Clientes</text>
    <text x="1510" y="134" text-anchor="end" fill="#d7e6fb" font-size="24" font-family="${font}">${escapeXml(report.startDate)} a ${escapeXml(report.endDate)}</text>
    <text x="70" y="260" fill="#162239" font-size="54" font-weight="900" font-family="${font}">${escapeXml(truncateText(report.locationTitle, 42))}</text>
    <text x="70" y="304" fill="#6b7b90" font-size="26" font-family="${font}">${escapeXml(truncateText(report.address, 82))}</text>
    ${card(70, 370, 340, 170, 'Impressões', s.totalImpressions)}
    ${card(445, 370, 340, 170, 'Interações', s.totalInteractions)}
    ${card(820, 370, 340, 170, 'Chamadas', s.calls)}
    ${card(1195, 370, 340, 170, 'Rotas', s.directions)}
    <rect x="70" y="610" width="1465" height="420" rx="30" fill="#ffffff" stroke="#d8e4f1" stroke-width="2"/>
    <text x="90" y="670" fill="#162239" font-size="38" font-weight="900" font-family="${font}">Impressões por origem</text>
    ${bar('Mobile - Busca', s.mobileSearch || 0, 725, '#24539b')}
    ${bar('Desktop - Busca', s.desktopSearch || 0, 790, '#4f9bd8')}
    ${bar('Mobile - Mapa', s.mobileMaps || 0, 855, '#0fb99a')}
    ${bar('Desktop - Mapa', s.desktopMaps || 0, 920, '#f3c24c')}
    <rect x="70" y="1090" width="1465" height="360" rx="30" fill="#ffffff" stroke="#d8e4f1" stroke-width="2"/>
    <text x="90" y="1150" fill="#162239" font-size="38" font-weight="900" font-family="${font}">Interações com o perfil</text>
    ${card(105, 1200, 400, 150, 'Visitas ao site', s.website)}
    ${card(600, 1200, 400, 150, 'Solicitações de rota', s.directions)}
    ${card(1095, 1200, 400, 150, 'Chamadas', s.calls)}
    <text x="70" y="1535" fill="#6b7b90" font-size="24" font-family="${font}">Relatório gerado pelo Radar Local LEME com dados autorizados da conta Google conectada.</text>
  </svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function buildReportPng(scan) {
  const settings = readDb().settings;
  const W = 1920;
  const H = 1080;
  const pad = 40;
  const headerX = 32;
  const headerY = 28;
  const headerW = W - 64;
  const headerH = 124;
  const leftX = 40;
  const leftY = 178;
  const leftW = 455;
  const mapX = 535;
  const mapY = 178;
  const mapW = 1345;
  const mapH = 760;
  const legendY = 980;
  const logicalW = 640;
  const logicalH = 362;
  const font = reportFont();
  const logoWhite = readAssetBase64('logo-horizontal-white.png');

  const staticMap = await getStaticMapDataUri(scan, logicalW, logicalH);
  const zoom = staticMap.zoom;
  const center = scan.center;
  const sx = mapW / logicalW;
  const sy = mapH / logicalH;

  const colors = { green: '#0fb99a', yellow: '#f3c24c', red: '#ef5b7c', gray: '#93a1b2' };
  const pointPixel = (point) => {
    const px = pointToPixel(point, center, zoom, logicalW, logicalH);
    const cropX = staticMap.cropX ?? 0;
    const cropY = staticMap.cropY ?? 0;
    const cropW = staticMap.cropW ?? logicalW;
    const cropH = staticMap.cropH ?? logicalH;
    return {
      x: mapX + ((px.x - cropX) / cropW) * mapW,
      y: mapY + ((px.y - cropY) / cropH) * mapH
    };
  };

  function wrapLines(value, maxChars, maxLines = 2) {
    const words = String(value || '—').trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length <= maxChars) {
        line = next;
      } else {
        if (line) lines.push(line);
        line = word.length > maxChars ? word.slice(0, maxChars - 1) + '…' : word;
      }
      if (lines.length >= maxLines) break;
    }
    if (lines.length < maxLines && line) lines.push(line);
    if (!lines.length) lines.push('—');
    if (lines.length > maxLines) lines.length = maxLines;
    const last = lines[lines.length - 1];
    const original = String(value || '');
    if (original.length > lines.join(' ').length && !last.endsWith('…')) {
      lines[lines.length - 1] = last.length > maxChars - 1 ? last.slice(0, maxChars - 1) + '…' : last + '…';
    }
    return lines;
  }

  function textLines(lines, x, y, size, weight, fill, lineHeight = Math.round(size * 1.18)) {
    return lines.map((line, i) => `<text x="${x}" y="${y + i * lineHeight}" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="${font}">${escapeXml(line)}</text>`).join('');
  }

  const lineEls = [];
  for (let row = 0; row < scan.gridSize; row++) {
    const rowPoints = scan.points.filter(p => p.row === row).sort((a, b) => a.col - b.col);
    if (rowPoints.length > 1) {
      const d = rowPoints.map((p, i) => {
        const pt = pointPixel(p);
        return `${i ? 'L' : 'M'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
      }).join(' ');
      lineEls.push(`<path d="${d}" fill="none" stroke="#355c96" stroke-width="3" stroke-opacity="0.42"/>`);
    }
  }
  for (let col = 0; col < scan.gridSize; col++) {
    const colPoints = scan.points.filter(p => p.col === col).sort((a, b) => a.row - b.row);
    if (colPoints.length > 1) {
      const d = colPoints.map((p, i) => {
        const pt = pointPixel(p);
        return `${i ? 'L' : 'M'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
      }).join(' ');
      lineEls.push(`<path d="${d}" fill="none" stroke="#355c96" stroke-width="3" stroke-opacity="0.42"/>`);
    }
  }

  const pointEls = scan.points.map(point => {
    const { x, y } = pointPixel(point);
    const color = colors[point.color] || colors.gray;
    const label = point.position ? String(point.position) : '—';
    const fontSize = label.length >= 3 ? 17 : label.length === 2 ? 21 : 25;
    return `<g>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="23" fill="#ffffff" fill-opacity="0.97"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="19" fill="${color}" stroke="#ffffff" stroke-width="4"/>
      <text x="${x.toFixed(1)}" y="${(y + 8).toFixed(1)}" text-anchor="middle" font-size="${fontSize}" font-weight="900" fill="#102033" font-family="${font}">${escapeXml(label)}</text>
    </g>`;
  }).join('');

  const logo = logoWhite
    ? `<image href="data:image/png;base64,${logoWhite}" x="64" y="70" width="260" height="34" preserveAspectRatio="xMinYMid meet"/>`
    : `<text x="64" y="96" fill="#fff" font-size="42" font-weight="900" font-family="${font}">LEME</text>`;

  const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(scan.createdAt));
  const reportTitle = truncateText(settings.reportTitle || 'Relatório de Desempenho Local', 42);
  const clientName = scan.clientName || '';
  const specialty = scan.clientSpecialty || scan.clientSnapshot?.specialty || '';
  const city = scan.clientCity || scan.clientSnapshot?.city || '';
  const keyword = scan.keyword || '';
  const positionText = String(scan.summary.averagePosition ?? '—');

  const clientNameSvg = textLines(wrapLines(clientName, 17, 2), leftX + 26, leftY + 52, 42, 900, '#162239', 48);
  const specialtySvg = textLines(wrapLines(specialty || '—', 22, 1), leftX + 26, leftY + 178, 28, 800, '#24344c');
  const citySvg = textLines(wrapLines(city || '—', 22, 1), leftX + 26, leftY + 274, 28, 800, '#24344c');
  const keywordSvg = textLines(wrapLines(keyword || '—', 24, 2), leftX + 26, leftY + 372, 27, 800, '#24344c', 33);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="header" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#163b73"/>
        <stop offset="1" stop-color="#27539b"/>
      </linearGradient>
      <clipPath id="mapClip"><rect x="${mapX}" y="${mapY}" width="${mapW}" height="${mapH}" rx="28"/></clipPath>
    </defs>
    <rect width="${W}" height="${H}" fill="#f6f8fc"/>
    <rect x="${headerX}" y="${headerY}" width="${headerW}" height="${headerH}" rx="26" fill="url(#header)"/>
    ${logo}
    <text x="1820" y="82" text-anchor="end" fill="#ffffff" font-size="34" font-weight="900" font-family="${font}">${escapeXml(reportTitle)}</text>
    <text x="1820" y="116" text-anchor="end" fill="#d7e6fb" font-size="18" font-family="${font}">${escapeXml(date)}</text>

    <rect x="${leftX}" y="${leftY}" width="${leftW}" height="${mapH}" rx="28" fill="#ffffff" stroke="#d8e4f1" stroke-width="2"/>
    ${clientNameSvg}

    <text x="${leftX + 26}" y="${leftY + 136}" fill="#6b7b90" font-size="17" font-weight="700" font-family="${font}">Especialidade</text>
    ${specialtySvg}

    <text x="${leftX + 26}" y="${leftY + 232}" fill="#6b7b90" font-size="17" font-weight="700" font-family="${font}">Cidade</text>
    ${citySvg}

    <text x="${leftX + 26}" y="${leftY + 330}" fill="#6b7b90" font-size="17" font-weight="700" font-family="${font}">Palavra-chave</text>
    ${keywordSvg}

    <rect x="${leftX + 26}" y="${leftY + 465}" width="${leftW - 52}" height="214" rx="24" fill="#eff5fb" stroke="#d8e4f1" stroke-width="2"/>
    <text x="${leftX + 52}" y="${leftY + 523}" fill="#6b7b90" font-size="22" font-weight="800" font-family="${font}">Posição média</text>
    <text x="${leftX + 52}" y="${leftY + 626}" fill="#1b4383" font-size="98" font-weight="900" font-family="${font}">${escapeXml(positionText)}</text>

    <rect x="${mapX}" y="${mapY}" width="${mapW}" height="${mapH}" rx="28" fill="#ffffff" stroke="#d8e4f1" stroke-width="2"/>
    <image href="${staticMap.dataUri}" x="${mapX}" y="${mapY}" width="${mapW}" height="${mapH}" preserveAspectRatio="none" clip-path="url(#mapClip)"/>
    <g clip-path="url(#mapClip)">${lineEls.join('')} ${pointEls}</g>
    <rect x="${mapX}" y="${mapY}" width="${mapW}" height="${mapH}" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2"/>

    <g transform="translate(${mapX}, ${legendY})">
      <circle cx="18" cy="0" r="10" fill="#0fb99a"/><text x="38" y="8" fill="#5f6f82" font-size="22" font-weight="800" font-family="${font}">Top 3</text>
      <circle cx="208" cy="0" r="10" fill="#f3c24c"/><text x="228" y="8" fill="#5f6f82" font-size="22" font-weight="800" font-family="${font}">Top 10</text>
      <circle cx="430" cy="0" r="10" fill="#ef5b7c"/><text x="450" y="8" fill="#5f6f82" font-size="22" font-weight="800" font-family="${font}">11+</text>
      <circle cx="590" cy="0" r="10" fill="#93a1b2"/><text x="610" y="8" fill="#5f6f82" font-size="22" font-weight="800" font-family="${font}">Não apareceu</text>
    </g>

    <text x="${leftX}" y="1040" fill="#71829b" font-size="20" font-weight="800" font-family="${font}">${escapeXml(settings.agencyName)} · Radar Local</text>
  </svg>`;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}


async function searchProspectPlaces({ query, city, specialty }) {
  if (!GOOGLE_MAPS_BACKEND_KEY) throw new Error('GOOGLE_MAPS_BACKEND_KEY não configurada no servidor.');
  const textQuery = [query, specialty, city, 'Brasil'].filter(Boolean).join(' ').trim();
  if (!textQuery) throw new Error('Digite um nome, cidade ou especialidade para buscar.');
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_BACKEND_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location'
    },
    body: JSON.stringify({ textQuery, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 10 })
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error?.message || 'Erro ao buscar perfis no Google.');
  return (json.places || []).map(place => ({
    placeId: cleanPlaceId(place.id),
    name: place.displayName?.text || 'Perfil sem nome',
    address: place.formattedAddress || '',
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null
  })).filter(p => p.placeId);
}

async function createExternalScan({ target, keyword, gridSize, radiusKm, centerLat, centerLng, includeCompetitors = false, sourceScan = null }) {
  const db = readDb();
  const grid = sanitizeGridSize(gridSize || db.settings.defaultGridSize);
  const radius = sanitizeRadius(radiusKm || db.settings.defaultRadiusKm);
  const targetPlaceId = cleanPlaceId(target.placeId);
  if (!targetPlaceId) throw new Error('Place ID do alvo não encontrado.');
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('Informe a palavra-chave.');

  let profileLat = normalizeNumber(target.profileLat ?? target.lat);
  let profileLng = normalizeNumber(target.profileLng ?? target.lng);
  if ((profileLat === null || profileLng === null) && targetPlaceId) {
    const coords = await geocodeByPlaceId(targetPlaceId);
    if (coords) { profileLat = coords.lat; profileLng = coords.lng; if (!target.address) target.address = coords.formattedAddress || ''; }
  }

  const finalCenterLat = normalizeNumber(centerLat) ?? normalizeNumber(sourceScan?.center?.lat) ?? profileLat;
  const finalCenterLng = normalizeNumber(centerLng) ?? normalizeNumber(sourceScan?.center?.lng) ?? profileLng;
  if (finalCenterLat === null || finalCenterLng === null) throw new Error('Centro do grid não encontrado.');

  const searchRadiusMeters = getSearchRadiusMeters(radius, grid);
  const gridPoints = generateGrid(finalCenterLat, finalCenterLng, grid, radius);
  const results = [];
  const competitorMap = new Map();

  for (const point of gridPoints) {
    const places = await searchPlacesAtPoint({ query: kw, lat: point.lat, lng: point.lng, searchRadiusMeters, includeNames: Boolean(includeCompetitors) });
    const placeIds = places.map(place => place.id);
    const index = placeIds.findIndex(placeId => placeId === targetPlaceId);
    const position = index === -1 ? null : index + 1;
    if (includeCompetitors) {
      places.forEach((place, idx) => {
        if (!place.id || place.id === targetPlaceId) return;
        if (!competitorMap.has(place.id)) competitorMap.set(place.id, { name: place.name, positions: [] });
        const data = competitorMap.get(place.id);
        if (!data.name && place.name) data.name = place.name;
        data.positions.push(idx + 1);
      });
    }
    results.push({ ...point, position, color: rankColor(position), checkedResults: places.length, checkedAt: new Date().toISOString() });
  }

  if (includeCompetitors) {
    const targetPositions = results.map(point => point.position).filter(Boolean);
    competitorMap.set(targetPlaceId, {
      name: target.name || 'Perfil analisado',
      positions: targetPositions,
      isTarget: true
    });
  }

  const targetId = target.id || id('prospect');
  const scan = {
    id: id('scan'),
    clientId: targetId,
    clientName: target.name || 'Prospect sem nome',
    clientCity: target.city || sourceScan?.clientCity || '',
    clientSpecialty: target.specialty || sourceScan?.clientSpecialty || '',
    clientAddress: target.address || '',
    clientPlaceId: targetPlaceId,
    clientSnapshot: {
      id: targetId,
      name: target.name || 'Prospect sem nome',
      city: target.city || sourceScan?.clientCity || '',
      specialty: target.specialty || sourceScan?.clientSpecialty || '',
      address: target.address || '',
      placeId: targetPlaceId,
      profileLat,
      profileLng
    },
    keywordId: target.keywordId || 'quick_keyword',
    keyword: kw,
    gridSize: grid,
    radiusKm: radius,
    searchRadiusMeters,
    center: { lat: Number(finalCenterLat.toFixed(7)), lng: Number(finalCenterLng.toFixed(7)) },
    points: results,
    summary: summarizeScan(results),
    competitors: includeCompetitors ? summarizeCompetitors(competitorMap, results.length) : [],
    competitorsEnabled: Boolean(includeCompetitors),
    source: target.source || 'prospect',
    createdAt: new Date().toISOString(),
    note: 'Resultado gerado por busca geolocalizada via Google Places. Trate como fotografia estratégica do momento.'
  };

  const latestDb = readDb();
  latestDb.scans.push(scan);
  writeDb(latestDb);
  return scan;
}

async function createScan({ clientId, keywordId, gridSize, radiusKm, centerLat, centerLng, saveCenter = false, includeCompetitors = false }) {
  const db = readDb();
  const client = db.clients.find(c => c.id === clientId);
  const keyword = db.keywords.find(k => k.id === keywordId && k.clientId === clientId);
  if (!client) throw new Error('Cliente inválido.');
  if (!keyword) throw new Error('Palavra-chave inválida.');
  if (client.status === 'inactive') throw new Error('Cliente inativo.');
  if (keyword.status === 'inactive') throw new Error('Palavra-chave inativa.');

  const grid = sanitizeGridSize(gridSize || client.defaultGridSize || db.settings.defaultGridSize);
  const radius = sanitizeRadius(radiusKm || client.defaultRadiusKm || db.settings.defaultRadiusKm);
  const finalCenterLat = normalizeNumber(centerLat) ?? normalizeNumber(client.gridCenterLat) ?? normalizeNumber(client.profileLat);
  const finalCenterLng = normalizeNumber(centerLng) ?? normalizeNumber(client.gridCenterLng) ?? normalizeNumber(client.profileLng);
  if (finalCenterLat === null || finalCenterLng === null) throw new Error('Centro do grid não encontrado. Resolva a localização do cliente.');

  const searchRadiusMeters = getSearchRadiusMeters(radius, grid);
  const gridPoints = generateGrid(finalCenterLat, finalCenterLng, grid, radius);
  const targetPlaceId = cleanPlaceId(client.placeId);
  const results = [];
  const competitorMap = new Map();

  for (const point of gridPoints) {
    const places = await searchPlacesAtPoint({ query: keyword.term, lat: point.lat, lng: point.lng, searchRadiusMeters, includeNames: Boolean(includeCompetitors) });
    const placeIds = places.map(place => place.id);
    const index = placeIds.findIndex(placeId => placeId === targetPlaceId);
    const position = index === -1 ? null : index + 1;
    if (includeCompetitors) {
      places.forEach((place, idx) => {
        if (!place.id || place.id === targetPlaceId) return;
        if (!competitorMap.has(place.id)) competitorMap.set(place.id, { name: place.name, positions: [] });
        const data = competitorMap.get(place.id);
        if (!data.name && place.name) data.name = place.name;
        data.positions.push(idx + 1);
      });
    }
    results.push({ ...point, position, color: rankColor(position), checkedResults: places.length, checkedAt: new Date().toISOString() });
  }

  if (includeCompetitors) {
    const targetPositions = results.map(point => point.position).filter(Boolean);
    competitorMap.set(targetPlaceId, {
      name: client.name || 'Cliente analisado',
      positions: targetPositions,
      isTarget: true
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
    clientSnapshot: {
      id: client.id,
      name: client.name,
      city: client.city,
      specialty: client.specialty,
      address: client.address,
      placeId: client.placeId,
      profileLat: client.profileLat,
      profileLng: client.profileLng
    },
    keywordId: keyword.id,
    keyword: keyword.term,
    gridSize: grid,
    radiusKm: radius,
    searchRadiusMeters,
    center: { lat: Number(finalCenterLat.toFixed(7)), lng: Number(finalCenterLng.toFixed(7)) },
    points: results,
    summary: summarizeScan(results),
    competitors: includeCompetitors ? summarizeCompetitors(competitorMap, results.length) : [],
    competitorsEnabled: Boolean(includeCompetitors),
    createdAt: new Date().toISOString(),
    note: 'Resultado gerado por busca geolocalizada via Google Places. Trate como fotografia estratégica do momento.'
  };

  const latestDb = readDb();
  latestDb.scans.push(scan);
  if (saveCenter) {
    const idx = latestDb.clients.findIndex(c => c.id === client.id);
    if (idx !== -1) {
      latestDb.clients[idx].gridCenterLat = scan.center.lat;
      latestDb.clients[idx].gridCenterLng = scan.center.lng;
      latestDb.clients[idx].defaultGridSize = grid;
      latestDb.clients[idx].defaultRadiusKm = radius;
      latestDb.clients[idx].updatedAt = new Date().toISOString();
    }
  }
  writeDb(latestDb);
  return scan;
}

function n8nPayload(scan, imageBase64) {
  return {
    event: 'radar_local_report_generated',
    source: 'radar-local-leme',
    scan: {
      id: scan.id,
      created_at: scan.createdAt,
      grid_size: scan.gridSize,
      radius_km: scan.radiusKm,
      search_radius_meters: scan.searchRadiusMeters,
      center: scan.center,
      keyword: { id: scan.keywordId, term: scan.keyword }
    },
    client: {
      id: scan.clientSnapshot.id,
      name: scan.clientSnapshot.name,
      city: scan.clientSnapshot.city,
      specialty: scan.clientSnapshot.specialty,
      address: scan.clientSnapshot.address,
      place_id: scan.clientSnapshot.placeId,
      profile_location: { lat: scan.clientSnapshot.profileLat, lng: scan.clientSnapshot.profileLng }
    },
    summary: {
      average_position: scan.summary.averagePosition,
      top3_percent: scan.summary.top3Percent,
      top10_percent: scan.summary.top10Percent,
      not_found_percent: scan.summary.notFoundPercent,
      best_position: scan.summary.bestPosition,
      worst_position: scan.summary.worstPosition
    },
    points: scan.points.map(p => ({ row: p.row, col: p.col, lat: p.lat, lng: p.lng, position: p.position, color: p.color, found: Boolean(p.position) })),
    competitors: scan.competitors || [],
    report: {
      file_name: `${slug(scan.clientName)}-${slug(scan.keyword)}-radar-local.png`,
      mime_type: 'image/png',
      image_base64: imageBase64,
      caption: `Relatório de posicionamento local gerado para ${scan.clientName}.`
    },
    methodology: {
      provider: 'Google Places API + Google Static Maps API',
      note: scan.note
    }
  };
}

async function sendScanToN8n(scan, webhookUrl) {
  const png = await buildReportPng(scan);
  const imageBase64 = png.toString('base64');
  const payload = n8nPayload(scan, imageBase64);
  const response = await fetch(webhookUrl || readDb().settings.n8nResultWebhookUrl || N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, response: text.slice(0, 500), payload };
}

function sanitizeClient(input, existing = {}) {
  return {
    ...existing,
    name: String(input.name ?? existing.name ?? '').trim(),
    city: String(input.city ?? existing.city ?? '').trim(),
    specialty: String(input.specialty ?? existing.specialty ?? '').trim(),
    address: String(input.address ?? existing.address ?? '').trim(),
    placeId: cleanPlaceId(input.placeId ?? existing.placeId),
    status: ['active', 'inactive'].includes(input.status) ? input.status : (existing.status || 'active'),
    defaultGridSize: sanitizeGridSize(input.defaultGridSize ?? existing.defaultGridSize ?? 5),
    defaultRadiusKm: sanitizeRadius(input.defaultRadiusKm ?? existing.defaultRadiusKm ?? 3),
    notes: String(input.notes ?? existing.notes ?? '').trim(),
    gridCenterLat: normalizeNumber(input.gridCenterLat ?? existing.gridCenterLat),
    gridCenterLng: normalizeNumber(input.gridCenterLng ?? existing.gridCenterLng),
    profileLat: normalizeNumber(input.profileLat ?? input.lat ?? existing.profileLat),
    profileLng: normalizeNumber(input.profileLng ?? input.lng ?? existing.profileLng)
  };
}

app.get('/api/config', requireAuth, (req, res) => {
  const db = readDb();
  res.json({
    googleMapsFrontendKey: GOOGLE_MAPS_FRONTEND_KEY,
    appName: 'Radar Local LEME',
    defaultGridSize: db.settings.defaultGridSize,
    defaultRadiusKm: db.settings.defaultRadiusKm,
    defaultTheme: db.settings.defaultTheme,
    webhookConfigured: Boolean(db.settings.n8nResultWebhookUrl),
    webhookUrl: String(db.settings.n8nResultWebhookUrl || '').replace(/\/webhook\/.+$/, '/webhook/...'),
    insightsConfigured: Boolean(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REDIRECT_URI)
  });
});

app.post('/api/login', (req, res) => {
  const { user, username, password } = req.body;
  if ((user || username) === APP_USER && password === APP_PASSWORD) {
    res.setHeader('Set-Cookie', makeSessionCookie(APP_USER));
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Usuário ou senha inválidos' });
});

app.post('/api/logout', (req, res) => {
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
  if (!req.body.name || !req.body.placeId) return res.status(400).json({ error: 'Preencha nome do cliente e Place ID.' });
  const base = sanitizeClient(req.body);
  let coords;
  try { coords = await resolveCoordinates(base); } catch (error) { return res.status(400).json({ error: error.message }); }
  const client = {
    id: id('cli'),
    ...base,
    profileLat: Number(Number(coords.lat).toFixed(7)),
    profileLng: Number(Number(coords.lng).toFixed(7)),
    lat: Number(Number(coords.lat).toFixed(7)),
    lng: Number(Number(coords.lng).toFixed(7)),
    gridCenterLat: base.gridCenterLat ?? Number(Number(coords.lat).toFixed(7)),
    gridCenterLng: base.gridCenterLng ?? Number(Number(coords.lng).toFixed(7)),
    coordinateSource: coords.source,
    address: base.address || coords.formattedAddress || '',
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
  const clean = sanitizeClient(req.body, current);
  const wantsResolve = req.body.resolveLocation === true || req.body.placeId || req.body.address || req.body.profileLat || req.body.profileLng || req.body.lat || req.body.lng;
  let coords = { lat: clean.profileLat, lng: clean.profileLng, source: current.coordinateSource || 'existing', formattedAddress: clean.address };
  if (wantsResolve) {
    try { coords = await resolveCoordinates(clean); } catch (error) { return res.status(400).json({ error: error.message }); }
  }
  db.clients[index] = {
    ...current,
    ...clean,
    profileLat: Number(Number(coords.lat).toFixed(7)),
    profileLng: Number(Number(coords.lng).toFixed(7)),
    lat: Number(Number(coords.lat).toFixed(7)),
    lng: Number(Number(coords.lng).toFixed(7)),
    gridCenterLat: clean.gridCenterLat ?? current.gridCenterLat ?? Number(Number(coords.lat).toFixed(7)),
    gridCenterLng: clean.gridCenterLng ?? current.gridCenterLng ?? Number(Number(coords.lng).toFixed(7)),
    coordinateSource: coords.source,
    address: clean.address || coords.formattedAddress || '',
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

app.post('/api/clients/:id/resolve-location', requireAuth, async (req, res) => {
  const db = readDb();
  const client = db.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  try {
    const coords = await resolveCoordinates({ ...client, ...req.body });
    client.profileLat = Number(Number(coords.lat).toFixed(7));
    client.profileLng = Number(Number(coords.lng).toFixed(7));
    client.lat = client.profileLat;
    client.lng = client.profileLng;
    if (!client.gridCenterLat || !client.gridCenterLng) {
      client.gridCenterLat = client.profileLat;
      client.gridCenterLng = client.profileLng;
    }
    client.coordinateSource = coords.source;
    if (!client.address && coords.formattedAddress) client.address = coords.formattedAddress;
    client.updatedAt = new Date().toISOString();
    writeDb(db);
    res.json({ clientId: client.id, profileLat: client.profileLat, profileLng: client.profileLng, source: coords.source, formattedAddress: coords.formattedAddress });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/clients/:id/save-grid-center', requireAuth, (req, res) => {
  const db = readDb();
  const client = db.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const lat = normalizeNumber(req.body.gridCenterLat ?? req.body.centerLat);
  const lng = normalizeNumber(req.body.gridCenterLng ?? req.body.centerLng);
  if (lat === null || lng === null) return res.status(400).json({ error: 'Centro inválido.' });
  client.gridCenterLat = Number(lat.toFixed(7));
  client.gridCenterLng = Number(lng.toFixed(7));
  client.defaultRadiusKm = sanitizeRadius(req.body.defaultRadiusKm ?? req.body.radiusKm ?? client.defaultRadiusKm);
  client.defaultGridSize = sanitizeGridSize(req.body.defaultGridSize ?? req.body.gridSize ?? client.defaultGridSize);
  client.updatedAt = new Date().toISOString();
  writeDb(db);
  res.json(client);
});

app.get('/api/keywords', requireAuth, (req, res) => {
  const db = readDb();
  const clientId = req.query.clientId;
  const keywords = clientId ? db.keywords.filter(k => k.clientId === clientId) : db.keywords;
  res.json(keywords.sort((a, b) => a.term.localeCompare(b.term)));
});

app.get('/api/clients/:id/keywords', requireAuth, (req, res) => {
  const db = readDb();
  res.json(db.keywords.filter(k => k.clientId === req.params.id).sort((a, b) => a.term.localeCompare(b.term)));
});

app.post('/api/keywords', requireAuth, (req, res) => {
  const db = readDb();
  const client = db.clients.find(c => c.id === req.body.clientId);
  if (!client) return res.status(400).json({ error: 'Cliente inválido.' });
  if (!req.body.term) return res.status(400).json({ error: 'Informe a palavra-chave.' });
  const keyword = { id: id('kw'), clientId: client.id, term: String(req.body.term).trim(), status: req.body.status === 'inactive' ? 'inactive' : 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  db.keywords.push(keyword);
  writeDb(db);
  res.json(keyword);
});

app.put('/api/keywords/:id', requireAuth, (req, res) => {
  const db = readDb();
  const keyword = db.keywords.find(k => k.id === req.params.id);
  if (!keyword) return res.status(404).json({ error: 'Palavra não encontrada.' });
  if (req.body.term !== undefined) keyword.term = String(req.body.term).trim();
  if (req.body.status) keyword.status = req.body.status === 'inactive' ? 'inactive' : 'active';
  keyword.updatedAt = new Date().toISOString();
  writeDb(db);
  res.json(keyword);
});

app.delete('/api/keywords/:id', requireAuth, (req, res) => {
  const db = readDb();
  db.keywords = db.keywords.filter(k => k.id !== req.params.id);
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/grid/preview', requireAuth, (req, res) => {
  const db = readDb();
  const client = db.clients.find(c => c.id === req.body.clientId);
  const gridSize = sanitizeGridSize(req.body.gridSize || client?.defaultGridSize || db.settings.defaultGridSize);
  const radiusKm = sanitizeRadius(req.body.radiusKm || client?.defaultRadiusKm || db.settings.defaultRadiusKm);
  const centerLat = normalizeNumber(req.body.centerLat) ?? normalizeNumber(client?.gridCenterLat) ?? normalizeNumber(client?.profileLat);
  const centerLng = normalizeNumber(req.body.centerLng) ?? normalizeNumber(client?.gridCenterLng) ?? normalizeNumber(client?.profileLng);
  if (centerLat === null || centerLng === null) return res.status(400).json({ error: 'Centro inválido.' });
  res.json({ gridSize, radiusKm, centerLat, centerLng, points: generateGrid(centerLat, centerLng, gridSize, radiusKm) });
});


app.post('/api/prospects/search', requireAuth, async (req, res) => {
  try {
    const places = await searchProspectPlaces(req.body || {});
    res.json({ places });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/scans/run-prospect', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const scan = await createExternalScan({
      target: {
        placeId: body.placeId,
        name: body.name,
        address: body.address,
        city: body.city,
        specialty: body.specialty,
        profileLat: body.profileLat,
        profileLng: body.profileLng,
        source: 'prospect'
      },
      keyword: body.keyword,
      gridSize: body.gridSize,
      radiusKm: body.radiusKm,
      centerLat: body.centerLat || body.profileLat,
      centerLng: body.centerLng || body.profileLng,
      includeCompetitors: Boolean(body.includeCompetitors)
    });
    res.json(scan);
  } catch (error) {
    res.status(500).json({ error: error.message, detail: error.stack });
  }
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
  try {
    const scan = await createScan(req.body);
    res.json(scan);
  } catch (error) {
    res.status(500).json({ error: error.message, detail: error.stack });
  }
});


app.post('/api/scans/:id/run-competitor', requireAuth, async (req, res) => {
  const db = readDb();
  const sourceScan = db.scans.find(s => s.id === req.params.id);
  if (!sourceScan) return res.status(404).json({ error: 'Análise de origem não encontrada.' });
  try {
    const body = req.body || {};
    const scan = await createExternalScan({
      target: {
        placeId: body.placeId,
        name: body.name || 'Concorrente',
        city: sourceScan.clientCity,
        specialty: sourceScan.clientSpecialty,
        source: 'competitor'
      },
      keyword: sourceScan.keyword,
      gridSize: sourceScan.gridSize,
      radiusKm: sourceScan.radiusKm,
      centerLat: sourceScan.center.lat,
      centerLng: sourceScan.center.lng,
      includeCompetitors: Boolean(body.includeCompetitors),
      sourceScan
    });
    res.json(scan);
  } catch (error) {
    res.status(500).json({ error: error.message, detail: error.stack });
  }
});

app.get('/api/scans/:id/report.png', requireAuth, async (req, res) => {
  const db = readDb();
  const scan = db.scans.find(s => s.id === req.params.id);
  if (!scan) return res.status(404).send('Análise não encontrada.');
  try {
    const png = await buildReportPng(scan);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${slug(scan.clientName)}-${slug(scan.keyword)}-radar-local.png"`);
    res.send(png);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar relatório.', detail: error.message });
  }
});

app.post('/api/scans/:id/report', requireAuth, async (req, res) => {
  const db = readDb();
  const scan = db.scans.find(s => s.id === req.params.id);
  if (!scan) return res.status(404).json({ error: 'Análise não encontrada.' });
  try {
    const png = await buildReportPng(scan);
    res.json({ scanId: scan.id, fileName: `${slug(scan.clientName)}-${slug(scan.keyword)}-radar-local.png`, mimeType: 'image/png', imageBase64: png.toString('base64'), summary: scan.summary });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar relatório.', detail: error.message });
  }
});

app.post('/api/scans/:id/send-to-n8n', requireAuth, async (req, res) => {
  const db = readDb();
  const scan = db.scans.find(s => s.id === req.params.id);
  if (!scan) return res.status(404).json({ error: 'Análise não encontrada.' });
  try {
    const result = await sendScanToN8n(scan, req.body.webhookUrl || db.settings.n8nResultWebhookUrl);
    res.json({ success: result.ok, webhookStatus: result.status, response: result.response });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao enviar para n8n.', detail: error.message });
  }
});

app.post('/api/reports/generate', requireAuth, async (req, res) => {
  const db = readDb();
  const scan = db.scans.find(s => s.id === req.body.scanId);
  if (!scan) return res.status(404).json({ error: 'Análise não encontrada.' });
  try {
    const png = await buildReportPng(scan);
    res.json({ scanId: scan.id, fileName: `${slug(scan.clientName)}-${slug(scan.keyword)}-radar-local.png`, imageBase64: png.toString('base64'), summary: scan.summary });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar relatório.', detail: error.message });
  }
});

async function runAutomationJob(jobId, options) {
  const dbStart = readDb();
  const job = dbStart.jobs.find(j => j.id === jobId);
  if (!job) return;
  const clients = dbStart.clients.filter(c => (options.mode === 'client' ? c.id === options.clientId : c.status !== 'inactive'));
  const tasks = [];
  for (const client of clients) {
    const words = dbStart.keywords.filter(k => k.clientId === client.id && (options.keywords === 'all' || k.status !== 'inactive'));
    for (const keyword of words) tasks.push({ client, keyword });
  }
  job.total = tasks.length;
  job.status = 'running';
  writeDb(dbStart);

  for (const task of tasks) {
    const dbLoop = readDb();
    const currentJob = dbLoop.jobs.find(j => j.id === jobId);
    if (!currentJob) return;
    try {
      const scan = await createScan({
        clientId: task.client.id,
        keywordId: task.keyword.id,
        gridSize: options.gridSize || task.client.defaultGridSize,
        radiusKm: options.radiusKm || task.client.defaultRadiusKm,
        centerLat: options.useSavedGridCenter === false ? task.client.profileLat : task.client.gridCenterLat,
        centerLng: options.useSavedGridCenter === false ? task.client.profileLng : task.client.gridCenterLng,
        saveCenter: false,
        includeCompetitors: Boolean(options.includeCompetitors)
      });
      if (options.sendToN8n !== false) await sendScanToN8n(scan, dbLoop.settings.n8nResultWebhookUrl);
      currentJob.completed += 1;
      currentJob.results.push({ scanId: scan.id, clientName: scan.clientName, keyword: scan.keyword, ok: true });
    } catch (error) {
      currentJob.failed += 1;
      currentJob.results.push({ clientName: task.client.name, keyword: task.keyword.term, ok: false, error: error.message });
    }
    currentJob.updatedAt = new Date().toISOString();
    writeDb(dbLoop);
    await sleep(Number(options.delayMs || 1200));
  }

  const dbEnd = readDb();
  const endJob = dbEnd.jobs.find(j => j.id === jobId);
  if (endJob) {
    endJob.status = 'completed';
    endJob.finishedAt = new Date().toISOString();
    endJob.updatedAt = new Date().toISOString();
    writeDb(dbEnd);
  }
  runningJobs.delete(jobId);
}

function startAutomation(options) {
  if ([...runningJobs.values()].some(j => j.status === 'running')) throw new Error('Já existe uma automação em andamento.');
  const db = readDb();
  const activeClients = db.clients.filter(c => options.mode === 'client' ? c.id === options.clientId : c.status !== 'inactive');
  const estimatedScans = activeClients.reduce((sum, c) => sum + db.keywords.filter(k => k.clientId === c.id && (options.keywords === 'all' || k.status !== 'inactive')).length, 0);
  if (estimatedScans > 100) throw new Error('Limite de segurança: no máximo 100 análises por execução.');
  const job = { id: id('job'), status: 'queued', total: estimatedScans, completed: 0, failed: 0, results: [], options, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  db.jobs.unshift(job);
  writeDb(db);
  runningJobs.set(job.id, job);
  setTimeout(() => runAutomationJob(job.id, options).catch(err => console.error(err)), 100);
  return job;
}

app.post('/api/automation/run-all', requireAutomationToken, (req, res) => {
  try {
    const job = startAutomation({
      mode: 'all_active',
      sendToN8n: req.body.sendToN8n !== false,
      gridSize: sanitizeGridSize(req.body.gridSize),
      radiusKm: sanitizeRadius(req.body.radiusKm),
      useSavedGridCenter: req.body.useSavedGridCenter !== false,
      keywords: req.body.keywords === 'all' ? 'all' : 'active_only',
      delayMs: Number(req.body.delayMs || 1200)
    });
    res.json({ success: true, jobId: job.id, message: 'Automação iniciada.', estimatedScans: job.total });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/automation/run-client', requireAuth, (req, res) => {
  try {
    const job = startAutomation({
      mode: 'client',
      clientId: req.body.clientId,
      sendToN8n: req.body.sendToN8n !== false,
      gridSize: sanitizeGridSize(req.body.gridSize),
      radiusKm: sanitizeRadius(req.body.radiusKm),
      useSavedGridCenter: req.body.useSavedGridCenter !== false,
      keywords: req.body.keywords === 'all' ? 'all' : 'active_only',
      delayMs: Number(req.body.delayMs || 1200)
    });
    res.json({ success: true, jobId: job.id, message: 'Automação iniciada.', estimatedScans: job.total });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/automation/jobs', requireAuth, (req, res) => {
  const db = readDb();
  res.json(db.jobs.slice(0, 30));
});

app.get('/api/automation/jobs/:jobId', requireAuth, (req, res) => {
  const db = readDb();
  const job = db.jobs.find(j => j.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  res.json(job);
});

app.get('/api/settings', requireAuth, (req, res) => {
  const db = readDb();
  res.json({ ...db.settings, automationTokenConfigured: Boolean(AUTOMATION_TOKEN && AUTOMATION_TOKEN !== 'troque-este-token') });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const db = readDb();
  db.settings = { ...db.settings };
  ['n8nResultWebhookUrl', 'defaultTheme', 'agencyName', 'reportFooter', 'reportTitle'].forEach(key => {
    if (req.body[key] !== undefined) db.settings[key] = String(req.body[key]);
  });
  if (req.body.defaultGridSize !== undefined) db.settings.defaultGridSize = sanitizeGridSize(req.body.defaultGridSize);
  if (req.body.defaultRadiusKm !== undefined) db.settings.defaultRadiusKm = sanitizeRadius(req.body.defaultRadiusKm);
  writeDb(db);
  res.json(db.settings);
});

app.get('/api/insights/status', requireAuth, (req, res) => {
  const db = readDb();
  res.json({
    connected: Boolean(db.insightsGoogle?.token),
    connectedEmail: db.insightsGoogle?.connectedEmail || '',
    connectedAt: db.insightsGoogle?.connectedAt || null,
    profiles: db.insightsProfiles || [],
    reports: (db.insightsReports || []).slice(0, 20),
    oauthConfigured: Boolean(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REDIRECT_URI)
  });
});

app.get('/api/insights/connect', requireAuth, (req, res) => {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) return res.status(400).send('Variáveis GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET não configuradas.');
  const stateValue = crypto.randomBytes(16).toString('hex');
  const cookie = `google_oauth_state=${stateValue}.${sign(stateValue)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', GOOGLE_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_INSIGHTS_SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', stateValue);
  res.setHeader('Set-Cookie', cookie);
  res.redirect(url.toString());
});

app.get('/api/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const rawState = getCookie(req, 'google_oauth_state');
    const [savedState, savedSig] = String(rawState || '').split('.');
    if (!code || !state || !savedState || savedState !== state || sign(savedState) !== savedSig) throw new Error('Estado OAuth inválido. Tente conectar novamente.');
    const params = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      code: String(code),
      grant_type: 'authorization_code'
    });
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error_description || data.error || 'Falha ao conectar Google.');
    const token = { ...data, expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 };
    const user = await getGoogleUserInfo(token.access_token);
    saveGoogleToken(token, user.email || 'Conta Google conectada');
    res.setHeader('Set-Cookie', 'google_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.send('<html><body style="font-family:Arial;padding:32px"><h2>Conta Google conectada.</h2><p>Você já pode voltar ao Radar Local LEME e usar Insights Clientes.</p><script>setTimeout(()=>location.href="/",1200)</script></body></html>');
  } catch (error) {
    res.status(400).send(`<html><body style="font-family:Arial;padding:32px"><h2>Erro ao conectar</h2><p>${escapeXml(error.message)}</p><a href="/">Voltar</a></body></html>`);
  }
});

app.post('/api/insights/disconnect', requireAuth, (req, res) => {
  const db = readDb();
  db.insightsGoogle = { token: null, connectedEmail: '', connectedAt: null, updatedAt: new Date().toISOString() };
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/insights/sync-locations', requireAuth, async (req, res) => {
  try {
    const profiles = await listInsightsLocations();
    const db = readDb();
    db.insightsProfiles = profiles.map(profile => ({ ...profile, syncedAt: new Date().toISOString() }));
    writeDb(db);
    res.json({ ok: true, profiles: db.insightsProfiles });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/insights/locations', requireAuth, (req, res) => {
  const db = readDb();
  res.json(db.insightsProfiles || []);
});

app.post('/api/insights/report', requireAuth, async (req, res) => {
  try {
    const locationName = String(req.body.locationName || '').trim();
    if (!locationName) return res.status(400).json({ error: 'Selecione um perfil.' });
    const startDate = String(req.body.startDate || '').trim();
    const endDate = String(req.body.endDate || '').trim();
    if (!startDate || !endDate) return res.status(400).json({ error: 'Informe data inicial e final.' });
    const db = readDb();
    const profile = (db.insightsProfiles || []).find(p => p.name === locationName) || { name: locationName, title: locationName, address: '' };
    const metrics = await fetchInsightsMetrics(locationName, startDate, endDate);
    const report = {
      id: id('ins'),
      locationName,
      locationTitle: profile.title || locationName,
      address: profile.address || '',
      startDate,
      endDate,
      metrics,
      summary: insightsSummary(metrics),
      createdAt: new Date().toISOString()
    };
    db.insightsReports.unshift(report);
    db.insightsReports = db.insightsReports.slice(0, 100);
    writeDb(db);
    res.json(report);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/insights/reports/:id/report.png', requireAuth, async (req, res) => {
  const db = readDb();
  const report = (db.insightsReports || []).find(r => r.id === req.params.id);
  if (!report) return res.status(404).send('Relatório não encontrado.');
  try {
    const png = await buildInsightsReportPng(report);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${slug(report.locationTitle)}-insights-clientes.png"`);
    res.send(png);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureDb();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Radar Local LEME V3 rodando na porta ${PORT}`);
});
