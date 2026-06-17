const state = {
  clients: [],
  keywords: [],
  scans: [],
  config: null,
  map: null,
  markers: [],
  currentScan: null,
  theme: localStorage.getItem('radar-theme') || 'dark',
  isScanning: false
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function fmtDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function slug(value) {
  return String(value || 'radar-local-leme')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/(^-|-$)/g, '')
    .toLowerCase();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || 'Erro na requisição');
  return data;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem('radar-theme', state.theme);
  const isLight = state.theme === 'light';
  const sidebarLogo = $('#sidebarLogo');
  if (sidebarLogo) sidebarLogo.src = isLight ? '/assets/logo-horizontal.png' : '/assets/logo-horizontal-white.png';
  $$('.login-logo').forEach(logo => logo.src = isLight ? logo.dataset.logoLight : logo.dataset.logoDark);
  const toggle = $('#themeToggle');
  if (toggle) toggle.textContent = isLight ? 'Modo escuro' : 'Modo claro';
}

function showLogin() {
  $('#loginScreen').classList.remove('hidden');
  $('#app').classList.add('hidden');
}

function showApp() {
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

async function checkAuth() {
  applyTheme();
  try {
    await api('/api/me');
    showApp();
    await loadAll();
  } catch {
    showLogin();
  }
}

async function loadAll({ silent = false } = {}) {
  try {
    state.config = await api('/api/config');
    state.clients = await api('/api/clients');
    state.keywords = await api('/api/keywords');
    state.scans = await api('/api/scans');
    renderAll();
    if (!silent) setSync('Atualizado agora');
  } catch (err) {
    if (!silent) setSync('Falha ao atualizar');
  }
}

function setSync(text) {
  const el = $('#syncStatus');
  if (el) el.textContent = text || 'Autoatualização ativa';
}

function renderAll() {
  renderMetrics();
  renderClients();
  renderSelects();
  renderLatestScans();
  renderHistory();
}

function renderMetrics() {
  $('#metricClients').textContent = state.clients.length;
  $('#metricKeywords').textContent = state.keywords.length;
  $('#metricScans').textContent = state.scans.length;
  const latest = state.scans[0];
  $('#metricTop3').textContent = latest ? `${latest.summary.top3Percent}%` : '—';
}

function renderClients() {
  const el = $('#clientsList');
  if (!state.clients.length) {
    el.innerHTML = `<div class="item"><p>Nenhum cliente cadastrado ainda.</p></div>`;
    return;
  }

  el.innerHTML = state.clients.map(client => {
    const count = state.keywords.filter(k => k.clientId === client.id).length;
    const sourceLabel = {
      manual: 'coordenadas manuais',
      place_id: 'Place ID',
      address: 'endereço',
      existing: 'salvo'
    }[client.coordinateSource] || 'salvo';
    return `
      <div class="item">
        <div class="item-header">
          <div>
            <strong>${escapeHtml(client.name)}</strong>
            <small>${escapeHtml(client.city || 'Cidade não informada')} · ${escapeHtml(client.specialty || 'Especialidade não informada')}</small>
            <p>${count} palavra(s)-chave · Localização por ${escapeHtml(sourceLabel)}</p>
            <p class="tiny">${escapeHtml(client.address || '')}</p>
          </div>
          <div class="item-actions">
            <button class="secondary" onclick="deleteClient('${client.id}')">Excluir</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderSelects() {
  const clientOptions = state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  $('#keywordClientSelect').innerHTML = clientOptions || '<option value="">Cadastre um cliente</option>';
  $('#scanClientSelect').innerHTML = clientOptions || '<option value="">Cadastre um cliente</option>';
  renderKeywordSelect();
}

function renderKeywordSelect() {
  const clientId = $('#scanClientSelect').value;
  const keywords = state.keywords.filter(k => k.clientId === clientId);
  $('#scanKeywordSelect').innerHTML = keywords.map(k => `<option value="${k.id}">${escapeHtml(k.term)}</option>`).join('') || '<option value="">Cadastre uma palavra</option>';
}

function renderLatestScans() {
  const el = $('#latestScans');
  const latest = state.scans.slice(0, 5);
  if (!latest.length) {
    el.innerHTML = `<div class="item"><p>Você ainda não rodou nenhuma análise.</p></div>`;
    return;
  }
  el.innerHTML = latest.map(scanItem).join('');
}

function renderHistory() {
  const el = $('#historyList');
  if (!state.scans.length) {
    el.innerHTML = `<div class="item"><p>Nenhum histórico disponível.</p></div>`;
    return;
  }
  el.innerHTML = state.scans.map(scanItem).join('');
}

function scanItem(scan) {
  return `
    <div class="item">
      <div class="item-header">
        <div>
          <strong>${escapeHtml(scan.clientName)}</strong>
          <small>${escapeHtml(scan.keyword)} · ${fmtDate(scan.createdAt)}</small>
          <p>Top 3: ${scan.summary.top3Percent}% · Top 10: ${scan.summary.top10Percent}% · Média: ${scan.summary.averagePosition ?? '—'} · Raio: ${scan.radiusKm} km</p>
        </div>
        <div class="item-actions">
          <button class="secondary" onclick="openScan('${scan.id}')">Abrir</button>
        </div>
      </div>
    </div>`;
}

function setView(viewName) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#${viewName}View`).classList.remove('hidden');
  $$('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === viewName));

  const titles = {
    dashboard: ['Dashboard', 'Visão geral do posicionamento local.'],
    clients: ['Clientes', 'Cadastre os perfis que serão analisados.'],
    scan: ['Nova análise', 'Rode um grid manual para uma palavra-chave.'],
    history: ['Histórico', 'Compare análises já realizadas.']
  };
  $('#pageTitle').textContent = titles[viewName][0];
  $('#pageSubtitle').textContent = titles[viewName][1];

  if (viewName === 'scan' && state.currentScan) setTimeout(() => renderMap(state.currentScan), 150);
}

async function deleteClient(id) {
  if (!confirm('Excluir este cliente também apaga palavras e análises dele. Continuar?')) return;
  await api(`/api/clients/${id}`, { method: 'DELETE' });
  await loadAll();
}

async function deleteKeyword(id) {
  if (!confirm('Excluir palavra-chave?')) return;
  await api(`/api/keywords/${id}`, { method: 'DELETE' });
  await loadAll();
}

async function openScan(id) {
  const scan = await api(`/api/scans/${id}`);
  state.currentScan = scan;
  setView('scan');
  renderScanResult(scan);
}

function renderScanResult(scan) {
  $('#resultHint').textContent = `${scan.clientName} · ${scan.keyword} · ${fmtDate(scan.createdAt)}`;
  $('#resultSummary').innerHTML = `
    <div class="summary-card"><span>Posição média</span><strong>${scan.summary.averagePosition ?? '—'}</strong></div>
    <div class="summary-card"><span>Top 3</span><strong>${scan.summary.top3Percent}%</strong></div>
    <div class="summary-card"><span>Top 10</span><strong>${scan.summary.top10Percent}%</strong></div>
    <div class="summary-card"><span>Não apareceu</span><strong>${scan.summary.notFoundPercent}%</strong></div>
  `;
  $('#downloadReportBtn').disabled = false;
  $('#sendReportBtn').disabled = false;
  renderMap(scan);
}

function markerColor(color) {
  const colors = {
    green: '#00b894',
    yellow: '#f9c74f',
    red: '#ef476f',
    gray: '#8b98a8'
  };
  return colors[color] || colors.gray;
}

async function loadGoogleMaps() {
  if (window.google?.maps) return;
  if (!state.config?.googleMapsFrontendKey) {
    $('#map').innerHTML = '<div class="map-message">Configure GOOGLE_MAPS_FRONTEND_KEY para exibir o mapa.</div>';
    return;
  }
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-google-maps="true"]');
    if (existing) return resolve();
    const script = document.createElement('script');
    script.dataset.googleMaps = 'true';
    script.src = `https://maps.googleapis.com/maps/api/js?key=${state.config.googleMapsFrontendKey}`;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function renderMap(scan) {
  try {
    await loadGoogleMaps();
  } catch (error) {
    $('#map').innerHTML = '<div class="map-message">Não foi possível carregar o Google Maps. Confira a chave Frontend e o domínio liberado.</div>';
    return;
  }
  if (!window.google?.maps) return;

  const center = scan.center;
  state.map = new google.maps.Map($('#map'), {
    center,
    zoom: scan.radiusKm <= 1 ? 14 : scan.radiusKm <= 3 ? 13 : scan.radiusKm <= 8 ? 12 : 11,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true
  });

  state.markers.forEach(m => m.setMap(null));
  state.markers = [];

  const bounds = new google.maps.LatLngBounds();
  scan.points.forEach(point => {
    const label = point.position ? String(point.position) : '-';
    const marker = new google.maps.Marker({
      position: { lat: point.lat, lng: point.lng },
      map: state.map,
      label: { text: label, color: '#061626', fontWeight: '900' },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 15,
        fillColor: markerColor(point.color),
        fillOpacity: 1,
        strokeWeight: 2,
        strokeColor: '#ffffff'
      },
      title: `Linha ${point.row + 1}, coluna ${point.col + 1}: ${point.position ? 'posição ' + point.position : 'não apareceu'}`
    });
    state.markers.push(marker);
    bounds.extend(marker.getPosition());
  });

  const centerMarker = new google.maps.Marker({
    position: center,
    map: state.map,
    label: { text: 'C', color: '#ffffff', fontWeight: '900' },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 12,
      fillColor: '#0698c3',
      fillOpacity: 1,
      strokeWeight: 2,
      strokeColor: '#ffffff'
    },
    title: 'Local do cliente'
  });
  state.markers.push(centerMarker);

  state.map.fitBounds(bounds);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text || '').split(' ');
  let line = '';
  let cursorY = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY);
      line = word;
      cursorY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
  return cursorY;
}

async function buildReportImage(scan) {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext('2d');

  const dark = state.theme !== 'light';
  const bg = dark ? '#061626' : '#f7fafc';
  const panel = dark ? '#0e2238' : '#ffffff';
  const text = dark ? '#f2f7fb' : '#072033';
  const muted = dark ? '#9db2c6' : '#5d7184';
  const line = dark ? 'rgba(255,255,255,0.13)' : 'rgba(5,31,50,0.12)';
  const brand = '#0698c3';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const grad = ctx.createRadialGradient(220, 120, 30, 220, 120, 520);
  grad.addColorStop(0, dark ? 'rgba(6,152,195,0.40)' : 'rgba(6,152,195,0.20)');
  grad.addColorStop(1, 'rgba(6,152,195,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  try {
    const logo = await loadImage(dark ? '/assets/logo-horizontal-white.png' : '/assets/logo-horizontal.png');
    const ratio = logo.width / logo.height;
    const logoW = 230;
    ctx.drawImage(logo, 60, 52, logoW, logoW / ratio);
  } catch {}

  ctx.fillStyle = text;
  ctx.font = '800 46px Arial, sans-serif';
  ctx.fillText('Radar Local', 60, 175);

  ctx.fillStyle = muted;
  ctx.font = '500 24px Arial, sans-serif';
  drawText(ctx, `${scan.clientName} · ${scan.keyword}`, 60, 220, 900, 32);

  const date = fmtDate(scan.createdAt);
  ctx.fillStyle = muted;
  ctx.font = '500 20px Arial, sans-serif';
  ctx.fillText(`Grid ${scan.gridSize}x${scan.gridSize} · Raio ${scan.radiusKm} km · ${date}`, 60, 285);

  const metrics = [
    ['Posição média', scan.summary.averagePosition ?? '—'],
    ['Top 3', `${scan.summary.top3Percent}%`],
    ['Top 10', `${scan.summary.top10Percent}%`],
    ['Não apareceu', `${scan.summary.notFoundPercent}%`]
  ];

  metrics.forEach((m, i) => {
    const x = 60 + i * 245;
    roundedRect(ctx, x, 330, 220, 118, 26);
    ctx.fillStyle = panel;
    ctx.fill();
    ctx.strokeStyle = line;
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.font = '600 19px Arial, sans-serif';
    ctx.fillText(m[0], x + 22, 374);
    ctx.fillStyle = text;
    ctx.font = '900 38px Arial, sans-serif';
    ctx.fillText(String(m[1]), x + 22, 420);
  });

  roundedRect(ctx, 60, 495, 960, 620, 34);
  ctx.fillStyle = panel;
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.stroke();

  ctx.fillStyle = muted;
  ctx.font = '600 22px Arial, sans-serif';
  ctx.fillText('Mapa do grid', 92, 545);

  const grid = scan.gridSize;
  const areaX = 185;
  const areaY = 585;
  const areaSize = 760;
  const step = grid === 1 ? 0 : areaSize / (grid - 1);

  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.09)' : 'rgba(5,31,50,0.09)';
  ctx.lineWidth = 2;
  for (let i = 0; i < grid; i++) {
    const p = areaX + i * step;
    ctx.beginPath();
    ctx.moveTo(areaX, p);
    ctx.lineTo(areaX + areaSize, p);
    ctx.moveTo(p, areaY);
    ctx.lineTo(p, areaY + areaSize);
    ctx.stroke();
  }

  // Centro do cliente
  ctx.beginPath();
  ctx.arc(areaX + areaSize / 2, areaY + areaSize / 2, 17, 0, Math.PI * 2);
  ctx.fillStyle = brand;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 18px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('C', areaX + areaSize / 2, areaY + areaSize / 2 + 1);

  scan.points.forEach(point => {
    const x = areaX + point.col * step;
    const y = areaY + point.row * step;
    ctx.beginPath();
    ctx.arc(x, y, 28, 0, Math.PI * 2);
    ctx.fillStyle = markerColor(point.color);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = '#061626';
    ctx.font = '900 25px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(point.position ? String(point.position) : '-', x, y + 1);
  });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const legend = [
    ['Top 3', markerColor('green')],
    ['Top 10', markerColor('yellow')],
    ['11+', markerColor('red')],
    ['Não apareceu', markerColor('gray')]
  ];
  legend.forEach((l, i) => {
    const x = 92 + i * 210;
    ctx.beginPath();
    ctx.arc(x, 1068, 8, 0, Math.PI * 2);
    ctx.fillStyle = l[1];
    ctx.fill();
    ctx.fillStyle = muted;
    ctx.font = '600 18px Arial, sans-serif';
    ctx.fillText(l[0], x + 18, 1074);
  });

  roundedRect(ctx, 60, 1160, 960, 110, 28);
  ctx.fillStyle = dark ? 'rgba(255,255,255,0.055)' : 'rgba(5,31,50,0.045)';
  ctx.fill();
  ctx.fillStyle = muted;
  ctx.font = '500 20px Arial, sans-serif';
  drawText(ctx, 'Resultado gerado por busca geolocalizada via Google Places. Use como fotografia estratégica do momento, acompanhando evolução mês a mês.', 92, 1208, 890, 30);

  ctx.fillStyle = dark ? 'rgba(255,255,255,0.55)' : 'rgba(5,31,50,0.55)';
  ctx.font = '600 17px Arial, sans-serif';
  ctx.fillText('LEME Marketing Médico · Radar Local', 60, 1310);

  return canvas.toDataURL('image/png');
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function handleDownloadReport() {
  if (!state.currentScan) return;
  const btn = $('#downloadReportBtn');
  btn.disabled = true;
  try {
    const dataUrl = await buildReportImage(state.currentScan);
    downloadDataUrl(dataUrl, `${slug(state.currentScan.clientName)}-${slug(state.currentScan.keyword)}-radar-local.png`);
  } catch (err) {
    alert(`Erro ao gerar imagem: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function handleSendReport() {
  if (!state.currentScan) return;
  const btn = $('#sendReportBtn');
  const status = $('#reportStatus');
  btn.disabled = true;
  status.classList.remove('hidden');
  status.textContent = 'Gerando imagem e enviando para o n8n...';
  try {
    const imageDataUrl = await buildReportImage(state.currentScan);
    const response = await api(`/api/scans/${state.currentScan.id}/webhook`, {
      method: 'POST',
      body: JSON.stringify({ imageDataUrl })
    });
    status.textContent = `Relatório enviado com sucesso. Status do webhook: ${response.webhookStatus}.`;
  } catch (err) {
    status.textContent = `Erro ao enviar relatório: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  $('#loginMessage').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify(form) });
    showApp();
    await loadAll();
  } catch (err) {
    $('#loginMessage').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  showLogin();
});

$('#themeToggle').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  if (state.currentScan) renderMap(state.currentScan);
});

$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));

$('#clientForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Salvando...';
  try {
    await api('/api/clients', { method: 'POST', body: JSON.stringify(form) });
    e.currentTarget.reset();
    await loadAll();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar cliente';
  }
});

$('#keywordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  try {
    await api('/api/keywords', { method: 'POST', body: JSON.stringify(form) });
    e.currentTarget.reset();
    await loadAll();
    $('#keywordClientSelect').value = form.clientId;
    $('#scanClientSelect').value = form.clientId;
    renderKeywordSelect();
  } catch (err) {
    alert(err.message);
  }
});

$('#scanClientSelect').addEventListener('change', renderKeywordSelect);
$('#downloadReportBtn').addEventListener('click', handleDownloadReport);
$('#sendReportBtn').addEventListener('click', handleSendReport);

$('#scanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  const status = $('#scanStatus');

  state.isScanning = true;
  btn.disabled = true;
  status.classList.remove('hidden');
  status.textContent = 'Rodando análise. O app vai consultar ponto por ponto do grid. Não feche esta tela.';

  try {
    const scan = await api('/api/scans/run', { method: 'POST', body: JSON.stringify(form) });
    state.currentScan = scan;
    await loadAll();
    renderScanResult(scan);
    status.textContent = 'Análise concluída com sucesso.';
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
  } finally {
    state.isScanning = false;
    btn.disabled = false;
  }
});

setInterval(() => {
  if ($('#app').classList.contains('hidden') || state.isScanning) return;
  loadAll({ silent: true });
  setSync('Autoatualizado');
}, 30000);

checkAuth();
