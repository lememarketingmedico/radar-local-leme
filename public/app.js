const state = {
  clients: [],
  keywords: [],
  scans: [],
  config: null,
  map: null,
  markers: [],
  currentScan: null
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

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || 'Erro na requisição');
  return data;
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
  try {
    await api('/api/me');
    showApp();
    await loadAll();
  } catch {
    showLogin();
  }
}

async function loadAll() {
  state.config = await api('/api/config');
  state.clients = await api('/api/clients');
  state.keywords = await api('/api/keywords');
  state.scans = await api('/api/scans');
  renderAll();
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
    return `
      <div class="item">
        <div class="item-header">
          <div>
            <strong>${escapeHtml(client.name)}</strong>
            <small>${escapeHtml(client.city || 'Cidade não informada')} · ${escapeHtml(client.specialty || 'Especialidade não informada')}</small>
            <p>${count} palavra(s)-chave cadastrada(s)</p>
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
          <p>Top 3: ${scan.summary.top3Percent}% · Top 10: ${scan.summary.top10Percent}% · Média: ${scan.summary.averagePosition ?? '—'}</p>
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
  $('#resultSummary').innerHTML = `
    <div class="summary-card"><span>Posição média</span><strong>${scan.summary.averagePosition ?? '—'}</strong></div>
    <div class="summary-card"><span>Top 3</span><strong>${scan.summary.top3Percent}%</strong></div>
    <div class="summary-card"><span>Top 10</span><strong>${scan.summary.top10Percent}%</strong></div>
    <div class="summary-card"><span>Não apareceu</span><strong>${scan.summary.notFoundPercent}%</strong></div>
  `;
  renderMap(scan);
}

function markerColor(color) {
  const colors = {
    green: '#06d6a0',
    yellow: '#ffd166',
    red: '#ef476f',
    gray: '#8b98a8'
  };
  return colors[color] || colors.gray;
}

async function loadGoogleMaps() {
  if (window.google?.maps) return;
  if (!state.config?.googleMapsFrontendKey) {
    $('#map').innerHTML = '<div style="padding:20px;color:#8da4bb">Configure GOOGLE_MAPS_FRONTEND_KEY para exibir o mapa.</div>';
    return;
  }
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${state.config.googleMapsFrontendKey}`;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function renderMap(scan) {
  await loadGoogleMaps();
  if (!window.google?.maps) return;

  const center = scan.center;
  state.map = new google.maps.Map($('#map'), {
    center,
    zoom: scan.radiusKm <= 1 ? 14 : scan.radiusKm <= 3 ? 13 : 12,
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

  new google.maps.Marker({
    position: center,
    map: state.map,
    label: { text: 'C', color: '#ffffff', fontWeight: '900' },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 12,
      fillColor: '#2eb7ff',
      fillOpacity: 1,
      strokeWeight: 2,
      strokeColor: '#ffffff'
    },
    title: 'Local do cliente'
  });

  state.map.fitBounds(bounds);
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

$('#refreshBtn').addEventListener('click', loadAll);

$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));

$('#clientForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  try {
    await api('/api/clients', { method: 'POST', body: JSON.stringify(form) });
    e.currentTarget.reset();
    await loadAll();
  } catch (err) {
    alert(err.message);
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

$('#scanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  const status = $('#scanStatus');

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
    btn.disabled = false;
  }
});

checkAuth();
