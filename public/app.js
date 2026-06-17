const state = {
  clients: [],
  keywords: [],
  scans: [],
  jobs: [],
  settings: {},
  config: null,
  map: null,
  resultMarkers: [],
  previewMarkers: [],
  previewLines: [],
  profileMarker: null,
  centerMarker: null,
  moveHandleMarker: null,
  previewData: null,
  dragState: null,
  previewSeq: 0,
  currentScan: null,
  scanMode: 'new',
  theme: localStorage.getItem('radar-theme') || 'dark',
  googleLoaded: false,
  autoTimer: null,
  quickTarget: null,
  quickKeyword: ''
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const CLEAN_MAP_STYLES = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] }
];

function moveHandleIcon() {
  if (!window.google?.maps) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <circle cx="24" cy="24" r="20" fill="#ffffff" stroke="#8b98a8" stroke-width="2.5"/>
    <path d="M24 10l4.5 4.5h-3v6h-3v-6h-3L24 10zm0 28l-4.5-4.5h3v-6h3v6h3L24 38zM10 24l4.5-4.5v3h6v3h-6v3L10 24zm28 0l-4.5 4.5v-3h-6v-3h6v-3L38 24z" fill="#6f7d8d"/>
    <circle cx="24" cy="24" r="3.5" fill="#6f7d8d"/>
  </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(36, 36),
    anchor: new google.maps.Point(18, 18)
  };
}

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
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.includes('/api/login') && !path.includes('/api/me')) {
      clearInterval(state.autoTimer);
      showLogin();
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    throw new Error(data.error || data.detail || 'Erro na requisição');
  }
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
    startAutoRefresh();
  } catch {
    showLogin();
  }
}

function startAutoRefresh() {
  clearInterval(state.autoTimer);
  state.autoTimer = setInterval(() => loadAll({ silent: true }), 30000);
}

async function loadAll({ silent = false } = {}) {
  try {
    const [config, clients, keywords, scans, jobs, settings] = await Promise.all([
      api('/api/config'),
      api('/api/clients'),
      api('/api/keywords'),
      api('/api/scans'),
      api('/api/automation/jobs'),
      api('/api/settings')
    ]);
    state.config = config;
    state.clients = clients;
    state.keywords = keywords;
    state.scans = scans;
    state.jobs = jobs;
    state.settings = settings;
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
  renderKeywords();
  renderSelects();
  renderLatestScans();
  renderHistory();
  renderJobs();
  renderSettingsForm();
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
    return `<div class="item">
      <div class="item-header">
        <div>
          <strong>${escapeHtml(client.name)}</strong>
          <small>${escapeHtml(client.city || 'Cidade não informada')} · ${escapeHtml(client.specialty || 'Especialidade não informada')} · ${client.status === 'inactive' ? 'Inativo' : 'Ativo'}</small>
          <p>${count} palavra(s) · Grid padrão ${client.defaultGridSize || 5}x${client.defaultGridSize || 5} · Raio ${client.defaultRadiusKm || 3} km</p>
          <p class="tiny">Perfil: ${client.profileLat ?? '—'}, ${client.profileLng ?? '—'} · Centro: ${client.gridCenterLat ?? '—'}, ${client.gridCenterLng ?? '—'}</p>
        </div>
        <div class="item-actions">
          <button class="secondary" onclick="editClient('${client.id}')">Editar</button>
          <button class="secondary" onclick="resolveClientLocation('${client.id}')">Resolver</button>
          <button class="secondary danger-mini" onclick="deleteClient('${client.id}')">Excluir</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderKeywords() {
  const el = $('#keywordsList');
  if (!state.keywords.length) {
    el.innerHTML = `<div class="item"><p>Nenhuma palavra cadastrada ainda.</p></div>`;
    return;
  }
  el.innerHTML = state.keywords.map(keyword => {
    const client = state.clients.find(c => c.id === keyword.clientId);
    return `<div class="item">
      <div class="item-header">
        <div>
          <strong>${escapeHtml(keyword.term)}</strong>
          <small>${escapeHtml(client?.name || 'Cliente removido')} · ${keyword.status === 'inactive' ? 'Inativa' : 'Ativa'}</small>
        </div>
        <div class="item-actions">
          <button class="secondary danger-mini" onclick="deleteKeyword('${keyword.id}')">Excluir</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderSelects() {
  const activeClients = state.clients.filter(c => c.status !== 'inactive');
  const keywordClientPrevious = $('#keywordClientSelect')?.value || '';
  const scanClientPrevious = $('#scanClientSelect')?.value || '';
  let clientOptions = activeClients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (state.quickTarget) {
    clientOptions = `<option value="__prospect__">Análise rápida: ${escapeHtml(state.quickTarget.name || 'Prospect')}</option>` + clientOptions;
  }
  $('#keywordClientSelect').innerHTML = activeClients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('') || '<option value="">Cadastre um cliente</option>';
  $('#scanClientSelect').innerHTML = clientOptions || '<option value="">Cadastre um cliente</option>';

  if (activeClients.some(c => c.id === keywordClientPrevious)) $('#keywordClientSelect').value = keywordClientPrevious;
  if (scanClientPrevious === '__prospect__' && state.quickTarget) $('#scanClientSelect').value = '__prospect__';
  else if (activeClients.some(c => c.id === scanClientPrevious)) $('#scanClientSelect').value = scanClientPrevious;

  renderKeywordSelect();
}

function renderKeywordSelect() {
  const select = $('#scanKeywordSelect');
  const previous = select?.value || '';
  const clientId = $('#scanClientSelect').value;
  if (clientId === '__prospect__' && state.quickTarget) {
    const term = state.quickKeyword || $('#prospectRunForm')?.keyword?.value || 'palavra-chave';
    select.innerHTML = `<option value="__quick_keyword__">${escapeHtml(term)}</option>`;
    return;
  }
  const keywords = state.keywords.filter(k => k.clientId === clientId && k.status !== 'inactive');
  select.innerHTML = keywords.map(k => `<option value="${k.id}">${escapeHtml(k.term)}</option>`).join('') || '<option value="">Cadastre uma palavra</option>';
  if (keywords.some(k => k.id === previous)) select.value = previous;
}

function scanItem(scan) {
  return `<div class="item">
    <div class="item-header">
      <div>
        <strong>${escapeHtml(scan.clientName)}</strong>
        <small>${escapeHtml(scan.keyword)} · ${fmtDate(scan.createdAt)}</small>
        <p>Top 3: ${scan.summary.top3Percent}% · Top 10: ${scan.summary.top10Percent}% · Média: ${scan.summary.averagePosition ?? '—'} · Raio: ${scan.radiusKm} km</p>
      </div>
      <div class="item-actions">
        <button class="secondary" onclick="openScan('${scan.id}')">Abrir</button>
        <a class="button-like secondary" href="/api/scans/${scan.id}/report.png" target="_blank">Relatório</a>
      </div>
    </div>
  </div>`;
}

function renderLatestScans() {
  const el = $('#latestScans');
  const latest = state.scans.slice(0, 6);
  el.innerHTML = latest.length ? latest.map(scanItem).join('') : `<div class="item"><p>Você ainda não rodou nenhuma análise.</p></div>`;
}

function renderHistory() {
  const el = $('#historyList');
  el.innerHTML = state.scans.length ? state.scans.map(scanItem).join('') : `<div class="item"><p>Nenhum histórico disponível.</p></div>`;
}

function renderJobs() {
  const el = $('#jobsList');
  if (!state.jobs.length) {
    el.innerHTML = `<div class="item"><p>Nenhum job de automação ainda.</p></div>`;
    return;
  }
  el.innerHTML = state.jobs.slice(0, 12).map(job => `<div class="item">
    <strong>${escapeHtml(job.id)}</strong>
    <small>${escapeHtml(job.status)} · ${fmtDate(job.startedAt)}</small>
    <p>${job.completed}/${job.total} concluídos · ${job.failed} falha(s)</p>
  </div>`).join('');
}

function renderSettingsForm() {
  if (!state.settings) return;
  const form = $('#settingsForm');
  if (!form || form.dataset.filled === 'true') return;
  form.n8nResultWebhookUrl.value = state.settings.n8nResultWebhookUrl || '';
  form.defaultGridSize.value = String(state.settings.defaultGridSize || 5);
  form.defaultRadiusKm.value = state.settings.defaultRadiusKm || 3;
  form.agencyName.value = state.settings.agencyName || '';
  form.reportTitle.value = state.settings.reportTitle || '';
  form.reportFooter.value = state.settings.reportFooter || '';
  form.dataset.filled = 'true';
}

function setView(viewName, options = {}) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#${viewName}View`).classList.remove('hidden');
  $$('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === viewName));
  const titles = {
    dashboard: ['Dashboard', 'Visão geral do posicionamento local.'],
    clients: ['Clientes', 'Cadastre perfis, status e localização.'],
    keywords: ['Palavras', 'Gerencie termos ativos e inativos.'],
    scan: ['Nova análise', 'Ajuste o grid no mapa antes de rodar.'],
    prospect: ['Análise rápida', 'Gere grid para prospecção sem cadastrar cliente.'],
    history: ['Histórico', 'Compare análises já realizadas.'],
    automation: ['Automação', 'Rode análises em massa para clientes ativos.'],
    settings: ['Configurações', 'Controle webhook, relatório e padrões.']
  };
  $('#pageTitle').textContent = titles[viewName][0];
  $('#pageSubtitle').textContent = titles[viewName][1];

  if (viewName === 'scan') {
    const mode = options.mode || state.scanMode || 'new';
    setScanMode(mode);
    if (mode === 'new') setTimeout(() => initPreviewMap(), 150);
  } else {
    state.scanMode = 'new';
    $('#scanView')?.classList.remove('history-mode', 'result-mode', 'preview-mode');
  }
}

function setScanMode(mode) {
  state.scanMode = mode;
  const view = $('#scanView');
  const resultTitle = $('#resultPanelTitle');
  const hint = $('#resultHint');
  view.classList.remove('history-mode', 'result-mode', 'preview-mode');
  view.classList.add(mode === 'new' ? 'preview-mode' : mode === 'history' ? 'history-mode' : 'result-mode');

  if (mode === 'new') {
    if (resultTitle) resultTitle.textContent = 'Ajuste do grid';
    if (hint) hint.textContent = 'Arraste o ícone cinza ao lado esquerdo do grid. O grid acompanha o movimento.';
    $('#downloadReportBtn').disabled = !state.currentScan;
    $('#sendReportBtn').disabled = !state.currentScan;
    $('#competitorsPanel')?.classList.add('hidden');
  }
  if (mode === 'result') {
    if (resultTitle) resultTitle.textContent = 'Resultado da análise';
  }
  if (mode === 'history') {
    if (resultTitle) resultTitle.textContent = 'Resultado salvo';
  }
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

async function resolveClientLocation(id) {
  try {
    await api(`/api/clients/${id}/resolve-location`, { method: 'POST', body: JSON.stringify({}) });
    await loadAll();
    alert('Localização resolvida.');
  } catch (err) {
    alert(err.message);
  }
}

async function loadGoogleMaps() {
  if (window.google?.maps) return true;
  if (!state.config?.googleMapsFrontendKey) {
    $('#map').innerHTML = '<div class="map-message">Configure GOOGLE_MAPS_FRONTEND_KEY para exibir o mapa.</div>';
    return false;
  }
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-google-maps="true"]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.dataset.googleMaps = 'true';
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(state.config.googleMapsFrontendKey)}&language=pt-BR&region=BR`;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return true;
}

function markerColor(color) {
  return { green: '#00b894', yellow: '#f6c54f', red: '#ef476f', gray: '#8b98a8' }[color] || '#8b98a8';
}

function clearMapObjects() {
  [...state.resultMarkers, ...state.previewMarkers, ...state.previewLines].forEach(obj => obj.setMap?.(null));
  state.resultMarkers = [];
  state.previewMarkers = [];
  state.previewLines = [];
  if (state.profileMarker) state.profileMarker.setMap(null);
  if (state.centerMarker) state.centerMarker.setMap(null);
  if (state.moveHandleMarker) state.moveHandleMarker.setMap(null);
  state.profileMarker = null;
  state.centerMarker = null;
  state.moveHandleMarker = null;
  state.previewData = null;
  state.dragState = null;
}

function selectedClient() {
  if ($('#scanClientSelect').value === '__prospect__') return state.quickTarget;
  return state.clients.find(c => c.id === $('#scanClientSelect').value);
}

function setCenterFields(lat, lng) {
  $('#centerLat').value = Number(lat).toFixed(7);
  $('#centerLng').value = Number(lng).toFixed(7);
}

async function initPreviewMap() {
  const ok = await loadGoogleMaps().catch(() => false);
  if (!ok) return;
  const client = selectedClient();
  if (!client) return;
  const center = {
    lat: Number(client.gridCenterLat ?? client.profileLat),
    lng: Number(client.gridCenterLng ?? client.profileLng)
  };
  setCenterFields(center.lat, center.lng);
  if (!state.map) {
    state.map = new google.maps.Map($('#map'), {
      center,
      zoom: 13,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      styles: CLEAN_MAP_STYLES
    });
  } else {
    state.map.setCenter(center);
    state.map.setZoom(13);
    state.map.setOptions({ styles: CLEAN_MAP_STYLES });
  }
  setTimeout(() => state.map && google.maps.event.trigger(state.map, 'resize'), 80);
  await renderPreviewGrid();
}

async function renderPreviewGrid() {
  const client = selectedClient();
  if (!client || !state.map || state.scanMode !== 'new') return;
  const seq = ++state.previewSeq;

  $('#resultSummary').innerHTML = `<div class="preview-help">
    <strong>1. Mova o grid pelo ícone lateral</strong>
    <span>Arraste o ícone cinza ao lado esquerdo. O grid acompanha o movimento em tempo real.</span>
  </div>
  <div class="preview-help">
    <strong>2. Confira raio e grid</strong>
    <span>Use o raio livre para cobrir melhor a cidade sem desperdiçar pontos fora da área útil.</span>
  </div>
  <div class="preview-help">
    <strong>3. Rode a análise</strong>
    <span>Depois de rodar, a prévia desaparece e ficam apenas os números finais.</span>
  </div>`;

  const center = {
    lat: Number($('#centerLat').value || client.gridCenterLat || client.profileLat),
    lng: Number($('#centerLng').value || client.gridCenterLng || client.profileLng)
  };
  const gridSize = Number($('#scanGridSize').value || client.defaultGridSize || 5);
  const radiusKm = Number($('#scanRadiusKm').value || client.defaultRadiusKm || 3);
  setCenterFields(center.lat, center.lng);

  let preview;
  try {
    preview = await api('/api/grid/preview', {
      method: 'POST',
      body: JSON.stringify({ clientId: client.id, gridSize, radiusKm, centerLat: center.lat, centerLng: center.lng })
    });
  } catch (err) {
    if (seq === state.previewSeq && !String(err.message).includes('Sessão expirada')) $('#map').innerHTML = `<div class="map-message">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (seq !== state.previewSeq || state.scanMode !== 'new') return;

  clearMapObjects();

  state.profileMarker = new google.maps.Marker({
    map: state.map,
    position: { lat: Number(client.profileLat), lng: Number(client.profileLng) },
    title: 'Local real do perfil do cliente',
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#24539b', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 }
  });

  state.centerMarker = new google.maps.Marker({
    map: state.map,
    position: center,
    title: 'Centro atual do grid',
    draggable: false,
    label: { text: '+', color: '#ffffff', fontWeight: '900' },
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#24539b', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 }
  });

  preview.points.forEach(p => {
    const marker = new google.maps.Marker({
      map: state.map,
      position: { lat: p.lat, lng: p.lng },
      label: { text: `${p.row + 1}.${p.col + 1}`, color: '#ffffff', fontWeight: '900', fontSize: '10px' },
      title: `Busca simulada ${p.row + 1},${p.col + 1}`,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#8b98a8', fillOpacity: 0.86, strokeColor: '#ffffff', strokeWeight: 2 }
    });
    state.previewMarkers.push(marker);
  });

  for (let row = 0; row < gridSize; row++) {
    const rowPoints = preview.points.filter(p => p.row === row).map(p => ({ lat: p.lat, lng: p.lng }));
    state.previewLines.push(new google.maps.Polyline({ map: state.map, path: rowPoints, strokeColor: '#24539b', strokeOpacity: 0.55, strokeWeight: 2 }));
  }
  for (let col = 0; col < gridSize; col++) {
    const colPoints = preview.points.filter(p => p.col === col).map(p => ({ lat: p.lat, lng: p.lng }));
    state.previewLines.push(new google.maps.Polyline({ map: state.map, path: colPoints, strokeColor: '#24539b', strokeOpacity: 0.55, strokeWeight: 2 }));
  }

  const lats = preview.points.map(p => p.lat);
  const lngs = preview.points.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const handlePosition = {
    lat: (minLat + maxLat) / 2,
    lng: minLng - (maxLng - minLng) * 0.22
  };

  state.moveHandleMarker = new google.maps.Marker({
    map: state.map,
    position: handlePosition,
    draggable: true,
    title: 'Arraste para mover todo o grid',
    icon: moveHandleIcon()
  });
  state.moveHandleMarker.addListener('dragstart', () => {
    state.dragState = {
      handleStart: { ...handlePosition },
      centerStart: { ...center },
      pointsStart: preview.points.map(p => ({ lat: p.lat, lng: p.lng, row: p.row, col: p.col }))
    };
  });
  state.moveHandleMarker.addListener('drag', (evt) => {
    if (!state.dragState) return;
    const dLat = evt.latLng.lat() - state.dragState.handleStart.lat;
    const dLng = evt.latLng.lng() - state.dragState.handleStart.lng;
    const movedCenter = { lat: state.dragState.centerStart.lat + dLat, lng: state.dragState.centerStart.lng + dLng };
    state.centerMarker?.setPosition(movedCenter);
    setCenterFields(movedCenter.lat, movedCenter.lng);
    state.dragState.pointsStart.forEach((basePoint, idx) => {
      state.previewMarkers[idx]?.setPosition({ lat: basePoint.lat + dLat, lng: basePoint.lng + dLng });
    });
    for (let row = 0; row < gridSize; row++) {
      const rowPath = state.dragState.pointsStart.filter(p => p.row === row).map(p => ({ lat: p.lat + dLat, lng: p.lng + dLng }));
      state.previewLines[row]?.setPath(rowPath);
    }
    for (let col = 0; col < gridSize; col++) {
      const colPath = state.dragState.pointsStart.filter(p => p.col === col).map(p => ({ lat: p.lat + dLat, lng: p.lng + dLng }));
      state.previewLines[gridSize + col]?.setPath(colPath);
    }
  });
  state.moveHandleMarker.addListener('dragend', async (evt) => {
    if (!state.dragState) return;
    const dLat = evt.latLng.lat() - state.dragState.handleStart.lat;
    const dLng = evt.latLng.lng() - state.dragState.handleStart.lng;
    setCenterFields(state.dragState.centerStart.lat + dLat, state.dragState.centerStart.lng + dLng);
    state.dragState = null;
    await renderPreviewGrid();
  });

  const bounds = new google.maps.LatLngBounds();
  preview.points.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
  bounds.extend({ lat: Number(client.profileLat), lng: Number(client.profileLng) });
  bounds.extend(handlePosition);
  state.map.fitBounds(bounds, 70);
  setTimeout(() => {
    if (state.map && seq === state.previewSeq) google.maps.event.trigger(state.map, 'resize');
  }, 80);
}


function renderCompetitors(scan) {
  const panel = $('#competitorsPanel');
  if (!panel) return;
  const competitors = Array.isArray(scan.competitors) ? scan.competitors : [];
  if (!competitors.length) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  const rows = competitors.slice(0, 15).map((item, idx) => `
    <tr>
      <td class="rank-num">${idx + 1}</td>
      <td>${escapeHtml(item.name || item.placeId || 'Perfil sem nome')}</td>
      <td>${item.averagePosition ?? '—'}</td>
      <td class="muted-cell">${item.bestPosition ?? '—'}</td>
      <td class="muted-cell">${item.appearances}/${item.totalPoints}</td>
      <td class="muted-cell">${item.top10Percent}%</td>
      <td><button class="secondary mini-btn" onclick="runCompetitorGrid('${state.currentScan?.id || ''}','${item.placeId}','${escapeHtml(item.name || '')}')">Gerar grid</button></td>
    </tr>`).join('');
  panel.innerHTML = `<div class="competitors-head">
    <div>
      <h3>Ranking de concorrentes</h3>
      <p>Ordenado pela posição média nos pontos do grid.</p>
    </div>
    <p>${competitors.length} perfil(is) encontrado(s)</p>
  </div>
  <table class="competitors-table">
    <thead><tr><th>#</th><th>Perfil</th><th>Média</th><th>Melhor</th><th>Apareceu</th><th>Top 10</th><th>Ação</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  panel.classList.remove('hidden');
}

function renderScanResult(scan, mode = 'result') {
  state.currentScan = scan;
  setScanMode(mode);
  $('#resultHint').textContent = `${scan.clientName} · ${scan.keyword} · ${fmtDate(scan.createdAt)}`;
  $('#resultSummary').innerHTML = `<div class="summary-card"><span>Posição média</span><strong>${scan.summary.averagePosition ?? '—'}</strong></div>
    <div class="summary-card"><span>Top 3</span><strong>${scan.summary.top3Percent}%</strong></div>
    <div class="summary-card"><span>Top 10</span><strong>${scan.summary.top10Percent}%</strong></div>
    <div class="summary-card"><span>Não apareceu</span><strong>${scan.summary.notFoundPercent}%</strong></div>`;
  $('#downloadReportBtn').disabled = false;
  $('#sendReportBtn').disabled = false;
  renderResultMap(scan);
  renderCompetitors(scan);
}

async function renderResultMap(scan) {
  const ok = await loadGoogleMaps().catch(() => false);
  if (!ok) return;
  if (!state.map) {
    state.map = new google.maps.Map($('#map'), { center: scan.center, zoom: 13, mapTypeControl: false, streetViewControl: false, fullscreenControl: true, styles: CLEAN_MAP_STYLES });
  }
  clearMapObjects();
  scan.points.forEach(point => {
    const marker = new google.maps.Marker({
      map: state.map,
      position: { lat: point.lat, lng: point.lng },
      label: { text: point.position ? String(point.position) : '—', color: '#071927', fontWeight: '900', fontSize: '14px' },
      title: `Posição: ${point.position || 'não apareceu'}`,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 15, fillColor: markerColor(point.color), fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 }
    });
    state.resultMarkers.push(marker);
  });
  const bounds = new google.maps.LatLngBounds();
  scan.points.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
  state.map.fitBounds(bounds, 60);
}

async function openScan(id) {
  const scan = await api(`/api/scans/${id}`);
  state.currentScan = scan;
  setView('scan', { mode: 'history' });
  setTimeout(() => renderScanResult(scan, 'history'), 200);
}


function selectProspect(place) {
  const form = $('#prospectRunForm');
  form.placeId.value = place.placeId || '';
  form.name.value = place.name || '';
  form.address.value = place.address || '';
  form.profileLat.value = place.lat ?? '';
  form.profileLng.value = place.lng ?? '';
  form.selectedLabel.value = `${place.name || 'Perfil selecionado'}${place.address ? ' · ' + place.address : ''}`;
  if (!form.keyword.value) {
    const specialty = $('#prospectSearchForm')?.specialty?.value || '';
    const city = $('#prospectSearchForm')?.city?.value || '';
    form.keyword.value = [specialty, city].filter(Boolean).join(' ').trim();
  }
}

async function prepareProspectPreview() {
  const form = $('#prospectRunForm');
  if (!form?.placeId?.value) return alert('Selecione um perfil primeiro.');
  const city = $('#prospectSearchForm')?.city?.value || '';
  const specialty = $('#prospectSearchForm')?.specialty?.value || '';
  state.quickKeyword = form.keyword.value || [specialty, city].filter(Boolean).join(' ').trim();
  state.quickTarget = {
    id: '__prospect__',
    name: form.name.value || 'Prospect',
    city,
    specialty,
    address: form.address.value || '',
    placeId: form.placeId.value,
    profileLat: Number(form.profileLat.value),
    profileLng: Number(form.profileLng.value),
    gridCenterLat: Number(form.profileLat.value),
    gridCenterLng: Number(form.profileLng.value),
    defaultGridSize: Number(form.gridSize.value || 5),
    defaultRadiusKm: Number(form.radiusKm.value || 3),
    status: 'active'
  };
  renderSelects();
  $('#scanClientSelect').value = '__prospect__';
  $('#scanGridSize').value = String(state.quickTarget.defaultGridSize || 5);
  $('#scanRadiusKm').value = state.quickTarget.defaultRadiusKm || 3;
  setCenterFields(state.quickTarget.profileLat, state.quickTarget.profileLng);
  renderKeywordSelect();
  setView('scan', { mode: 'new' });
  setTimeout(() => initPreviewMap(), 150);
}
window.prepareProspectPreview = prepareProspectPreview;
window.selectProspect = selectProspect;

async function runCompetitorGrid(scanId, placeId, name) {
  if (!scanId || !placeId) return alert('Concorrente inválido.');
  if (!confirm(`Gerar grid para este concorrente?
${name || placeId}`)) return;
  const status = $('#reportStatus');
  status?.classList.remove('hidden');
  if (status) status.textContent = 'Rodando grid do concorrente...';
  try {
    const scan = await api(`/api/scans/${scanId}/run-competitor`, { method: 'POST', body: JSON.stringify({ placeId, name, includeCompetitors: true }) });
    await loadAll();
    setView('scan', { mode: 'result' });
    renderScanResult(scan, 'result');
    if (status) status.textContent = 'Grid do concorrente gerado com sucesso.';
  } catch (err) {
    if (status) status.textContent = `Erro: ${err.message}`;
    else alert(err.message);
  }
}
window.runCompetitorGrid = runCompetitorGrid;

$('#prospectSearchForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  const status = $('#prospectSearchStatus');
  const list = $('#prospectResults');
  status.classList.remove('hidden');
  status.textContent = 'Buscando perfis no Google...';
  list.innerHTML = '';
  try {
    const result = await api('/api/prospects/search', { method: 'POST', body: JSON.stringify(form) });
    const places = result.places || [];
    status.textContent = places.length ? `${places.length} resultado(s) encontrado(s). Escolha o perfil correto.` : 'Nenhum resultado encontrado.';
    list.innerHTML = places.map((place, idx) => `<div class="item">
      <div class="item-header">
        <div><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.address || '')}</small></div>
        <button class="secondary" onclick='selectProspect(${JSON.stringify(place).replaceAll("'", "&#039;")})'>Selecionar</button>
      </div>
    </div>`).join('');
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
  }
});

$('#prospectAdjustBtn')?.addEventListener('click', async () => {
  await prepareProspectPreview();
});

$('#prospectRunForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = Object.fromEntries(new FormData(e.currentTarget));
  raw.includeCompetitors = e.currentTarget.includeCompetitors.checked;
  raw.city = $('#prospectSearchForm')?.city?.value || '';
  raw.specialty = $('#prospectSearchForm')?.specialty?.value || '';
  const status = $('#prospectRunStatus');
  status.classList.remove('hidden');
  status.textContent = 'Rodando análise rápida...';
  try {
    if (!raw.placeId) throw new Error('Selecione um perfil primeiro.');
    const scan = await api('/api/scans/run-prospect', { method: 'POST', body: JSON.stringify(raw) });
    status.textContent = 'Análise rápida concluída.';
    await loadAll();
    setView('scan', { mode: 'result' });
    renderScanResult(scan, 'result');
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
  }
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  $('#loginMessage').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify(form) });
    showApp();
    await loadAll();
    startAutoRefresh();
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
});

$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
  if (btn.dataset.view === 'scan') {
    state.currentScan = null;
    setView('scan', { mode: 'new' });
  } else {
    setView(btn.dataset.view);
  }
}));

function resetClientForm() {
  const form = $('#clientForm');
  if (!form) return;
  form.reset();
  form.elements.id.value = '';
  $('#clientFormTitle').textContent = 'Novo cliente';
  $('#clientSubmitBtn').textContent = 'Salvar cliente';
  $('#clientCancelEditBtn').classList.add('hidden');
  form.classList.remove('client-editing');
}

function editClient(id) {
  const client = state.clients.find(c => c.id === id);
  if (!client) return;
  const form = $('#clientForm');
  form.elements.id.value = client.id;
  form.name.value = client.name || '';
  form.city.value = client.city || '';
  form.specialty.value = client.specialty || '';
  form.address.value = client.address || '';
  form.placeId.value = client.placeId || '';
  form.status.value = client.status || 'active';
  form.defaultGridSize.value = String(client.defaultGridSize || 5);
  form.defaultRadiusKm.value = client.defaultRadiusKm || 3;
  form.profileLat.value = client.profileLat ?? '';
  form.profileLng.value = client.profileLng ?? '';
  form.gridCenterLat.value = client.gridCenterLat ?? '';
  form.gridCenterLng.value = client.gridCenterLng ?? '';
  form.notes.value = client.notes || '';
  $('#clientFormTitle').textContent = 'Editar cliente';
  $('#clientSubmitBtn').textContent = 'Salvar alterações';
  $('#clientCancelEditBtn').classList.remove('hidden');
  form.classList.add('client-editing');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.editClient = editClient;

$('#clientCancelEditBtn').addEventListener('click', () => resetClientForm());

$('#clientForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  const btn = $('#clientSubmitBtn');
  const isEdit = Boolean(form.id);
  btn.disabled = true;
  btn.textContent = isEdit ? 'Salvando alterações...' : 'Salvando...';
  try {
    if (isEdit) {
      await api(`/api/clients/${form.id}`, { method: 'PUT', body: JSON.stringify(form) });
    } else {
      await api('/api/clients', { method: 'POST', body: JSON.stringify(form) });
    }
    resetClientForm();
    await loadAll();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = form.id ? 'Salvar alterações' : 'Salvar cliente';
  }
});

$('#keywordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  try {
    await api('/api/keywords', { method: 'POST', body: JSON.stringify(form) });
    e.currentTarget.reset();
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

$('#scanClientSelect').addEventListener('change', async () => {
  const client = selectedClient();
  if (client) {
    $('#scanGridSize').value = String(client.defaultGridSize || 5);
    $('#scanRadiusKm').value = client.defaultRadiusKm || 3;
    setCenterFields(client.gridCenterLat || client.profileLat, client.gridCenterLng || client.profileLng);
  }
  renderKeywordSelect();
  if (state.map) await renderPreviewGrid();
});

$('#scanGridSize').addEventListener('change', renderPreviewGrid);
$('#scanRadiusKm').addEventListener('change', renderPreviewGrid);

$('#centerOnProfileBtn').addEventListener('click', async () => {
  const client = selectedClient();
  if (!client) return;
  setCenterFields(client.profileLat, client.profileLng);
  await renderPreviewGrid();
});

$('#saveCenterBtn').addEventListener('click', async () => {
  const client = selectedClient();
  if (!client) return;
  if ($('#scanClientSelect').value === '__prospect__' && state.quickTarget) {
    state.quickTarget.gridCenterLat = Number($('#centerLat').value);
    state.quickTarget.gridCenterLng = Number($('#centerLng').value);
    alert('Centro ajustado para esta análise rápida.');
    return;
  }
  try {
    await api(`/api/clients/${client.id}/save-grid-center`, {
      method: 'POST',
      body: JSON.stringify({ centerLat: $('#centerLat').value, centerLng: $('#centerLng').value, gridSize: $('#scanGridSize').value, radiusKm: $('#scanRadiusKm').value })
    });
    await loadAll();
    alert('Centro salvo no cliente.');
  } catch (err) {
    alert(err.message);
  }
});

$('#scanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  form.saveCenter = e.currentTarget.saveCenter.checked;
  form.includeCompetitors = e.currentTarget.includeCompetitors?.checked || false;
  const status = $('#scanStatus');
  status.classList.remove('hidden');
  status.textContent = 'Rodando análise. Isso pode levar alguns segundos...';
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    let scan;
    if (form.clientId === '__prospect__' && state.quickTarget) {
      const body = {
        placeId: state.quickTarget.placeId,
        name: state.quickTarget.name,
        address: state.quickTarget.address,
        city: state.quickTarget.city,
        specialty: state.quickTarget.specialty,
        profileLat: state.quickTarget.profileLat,
        profileLng: state.quickTarget.profileLng,
        keyword: state.quickKeyword || $('#prospectRunForm')?.keyword?.value || $('#scanKeywordSelect option:checked')?.textContent || '',
        gridSize: form.gridSize,
        radiusKm: form.radiusKm,
        centerLat: form.centerLat,
        centerLng: form.centerLng,
        includeCompetitors: form.includeCompetitors
      };
      scan = await api('/api/scans/run-prospect', { method: 'POST', body: JSON.stringify(body) });
    } else {
      scan = await api('/api/scans/run', { method: 'POST', body: JSON.stringify(form) });
    }
    status.textContent = 'Análise concluída com sucesso.';
    await loadAll();
    renderScanResult(scan, 'result');
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$('#downloadReportBtn').addEventListener('click', () => {
  if (!state.currentScan) return;
  window.open(`/api/scans/${state.currentScan.id}/report.png`, '_blank');
});

$('#sendReportBtn').addEventListener('click', async () => {
  if (!state.currentScan) return;
  const status = $('#reportStatus');
  status.classList.remove('hidden');
  status.textContent = 'Gerando relatório e enviando para o n8n...';
  try {
    const result = await api(`/api/scans/${state.currentScan.id}/send-to-n8n`, { method: 'POST', body: JSON.stringify({}) });
    status.textContent = `Enviado. Status do webhook: ${result.webhookStatus}.`;
  } catch (err) {
    status.textContent = `Erro ao enviar: ${err.message}`;
  }
});

$('#reloadHistoryBtn').addEventListener('click', () => loadAll());

$('#automationForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  form.sendToN8n = e.currentTarget.sendToN8n.checked;
  form.useSavedGridCenter = e.currentTarget.useSavedGridCenter.checked;
  const status = $('#automationStatus');
  status.classList.remove('hidden');
  status.textContent = 'Iniciando automação...';
  try {
    const token = prompt('Informe o AUTOMATION_TOKEN configurado no EasyPanel:');
    const result = await api('/api/automation/run-all', { method: 'POST', headers: { 'x-automation-token': token || '' }, body: JSON.stringify(form) });
    status.textContent = `${result.message} Estimativa: ${result.estimatedScans} análises. Job: ${result.jobId}`;
    setTimeout(loadAll, 1200);
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
  }
});

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(form) });
    e.currentTarget.dataset.filled = 'false';
    await loadAll();
    alert('Configurações salvas.');
  } catch (err) {
    alert(err.message);
  }
});

checkAuth();
