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

async function searchPlacesAtPoint({ query, lat, lng, searchRadiusMeters = 1000, maxPages = 3 }) {
  if (!GOOGLE_MAPS_BACKEND_KEY) throw new Error('GOOGLE_MAPS_BACKEND_KEY não configurada no servidor.');
  const endpoint = 'https://places.googleapis.com/v1/places:searchText';
  let pageToken = null;
  const placeIds = [];
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
        'X-Goog-FieldMask': 'places.id,nextPageToken'
      },
      body: JSON.stringify(body)
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json?.error?.message || 'Erro ao consultar Places API');
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
    const margin = 6;
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
  const baseZoom = chooseZoom(scan.points, center, logicalW, logicalH);
  const zoom = Math.min(18, baseZoom + 1);
  const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
  url.searchParams.set('center', `${center.lat},${center.lng}`);
  url.searchParams.set('zoom', String(zoom));
  // Google Static Maps permite tamanho 640x640 com scale=2 para alta definição.
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

  const base64 = buffer.toString('base64');
  return { dataUri: `data:image/png;base64,${base64}`, zoom, logicalW, logicalH };
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
    return { x: mapX + px.x * sx, y: mapY + px.y * sy };
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

async function createScan({ clientId, keywordId, gridSize, radiusKm, centerLat, centerLng, saveCenter = false }) {
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

  for (const point of gridPoints) {
    const placeIds = await searchPlacesAtPoint({ query: keyword.term, lat: point.lat, lng: point.lng, searchRadiusMeters });
    const index = placeIds.findIndex(placeId => placeId === targetPlaceId);
    const position = index === -1 ? null : index + 1;
    results.push({ ...point, position, color: rankColor(position), checkedResults: placeIds.length, checkedAt: new Date().toISOString() });
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
    webhookUrl: String(db.settings.n8nResultWebhookUrl || '').replace(/\/webhook\/.+$/, '/webhook/...')
  });
});

app.post('/api/login', (req, res) => {
  const { user, username, password } = req.body;
  if ((user || username) === APP_USER && password === APP_PASSWORD) {
    const sessionId = crypto.randomBytes(24).toString('hex');
    sessions.set(sessionId, { user: APP_USER, createdAt: new Date().toISOString() });
    res.setHeader('Set-Cookie', makeSessionCookie(sessionId));
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Usuário ou senha inválidos' });
});

app.post('/api/logout', (req, res) => {
  const raw = getCookie(req, 'radar_session');
  if (raw) sessions.delete(raw.split('.')[0]);
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
        saveCenter: false
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureDb();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Radar Local LEME V3 rodando na porta ${PORT}`);
});
