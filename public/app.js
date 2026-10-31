const $ = selector => document.querySelector(selector);
const signalInput = $('#signalInput');
const signalChips = $('#signalChips');
const signals = [];
let toastTimer;
const dateTimeZone = 'Asia/Kolkata';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function showToast(message, kind = '') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast visible ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 6000);
}

function renderSignals() {
  signalChips.innerHTML = signals.map((signal, index) => `<span class="signal-chip">${escapeHtml(signal)}<button type="button" data-remove="${index}" aria-label="Remove ${escapeHtml(signal)}">×</button></span>`).join('');
  $('#signalEntry').classList.toggle('has-signals', signals.length > 0);
}

function addSignal(value = signalInput.value) {
  const signal = String(value).trim().replace(/\s+/g, ' ');
  if (!signal) return;
  if (signal.length > 160) return showToast('Keep each signal to 160 characters or fewer.', 'error');
  if (signals.some(s => s.toLowerCase() === signal.toLowerCase())) {
    signalInput.value = '';
    return showToast('That signal is already in your audience.', '');
  }
  if (signals.length >= 8) return showToast('Add up to eight signals for one discovery.', 'error');
  signals.push(signal);
  signalInput.value = '';
  renderSignals();
}

function collectText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join(' · ');
  if (value && typeof value === 'object') {
    const preferred = ['name', 'display_name', 'title', 'entity_name', 'label', 'description', 'reason', 'explanation', 'affinity', 'score'];
    return preferred.filter(key => value[key] !== undefined && value[key] !== null).map(key => {
      const val = value[key];
      return typeof val === 'object' ? collectText(val) : String(val);
    }).filter(Boolean).join(' · ');
  }
  return '';
}

function pickCandidates(result) {
  const likely = [result?.results, result?.interpretation?.results, result?.data?.results, result?.items, result?.recommendations];
  for (const value of likely) if (Array.isArray(value)) return value;
  return [];
}

function renderDiscovery(item) {
  const result = item.result || {};
  $('#historySection').hidden = true;
  $('#resultsSection').hidden = false;
  $('#resultsTitle').textContent = `${item.audienceName} · ${labelType(item.targetType)}`;
  $('#resultsSubtitle').textContent = `Signals: ${item.signals.join(' · ')} · ${new Date(item.createdAt).toLocaleString()}`;
  const summary = result.summary || result.interpretation?.summary || result.interpretation?.text;
  const summaryBox = $('#resultSummary');
  if (summary) {
    summaryBox.textContent = String(summary);
    summaryBox.hidden = false;
  } else summaryBox.hidden = true;

  const cards = pickCandidates(result);
  const cardsRoot = $('#resultCards');
  if (!cards.length) {
    const explanation = result.interpretation && typeof result.interpretation === 'string' ? result.interpretation : '';
    cardsRoot.innerHTML = `<div class="empty-results"><span>✳</span><h3>${result.status === 'empty' ? 'No affinities returned' : 'Qloo returned a result'}</h3><p>${escapeHtml(explanation || 'Review the full response below for the exact structured result and any workflow notes.')}</p></div>`;
  } else {
    cardsRoot.innerHTML = cards.map((candidate, index) => {
      const title = candidate?.name || candidate?.entity?.name || candidate?.display_name || candidate?.title || `Affinity ${index + 1}`;
      const evidence = candidate?.explanation || candidate?.reason || candidate?.description || candidate?.affinity_explanation;
      const score = candidate?.affinity ?? candidate?.score ?? candidate?.relevance;
      const tags = candidate?.tags || candidate?.matched_tags || candidate?.signals;
      return `<article class="result-card"><div class="candidate-image"><span>${String(index + 1).padStart(2, '0')}</span>${score !== undefined ? `<b>${escapeHtml(score)}</b>` : ''}</div><div class="candidate-body"><div class="candidate-type">QLOO AFFINITY</div><h3>${escapeHtml(title)}</h3>${evidence ? `<p>${escapeHtml(collectText(evidence))}</p>` : '<p class="no-evidence">No item-level explanation was included in this result.</p>'}${tags ? `<div class="candidate-tags">${escapeHtml(collectText(tags))}</div>` : ''}</div></article>`;
    }).join('');
  }
  $('#rawResponse').textContent = JSON.stringify(result, null, 2);
  $('#resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function labelType(type) {
  const labels = { tv_show: 'TV shows', videogame: 'video games' };
  return labels[type] || `${type}s`;
}

function qlooDate(value) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}

function currentQlooDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: dateTimeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function updateLiveDateAndRange() {
  $('#liveDate').textContent = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium', timeZone: dateTimeZone
  }).format(new Date());
  const days = Number($('#trendDays').value || 30);
  const end = new Date(`${currentQlooDate()}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  $('#trendRange').textContent = `${qlooDate(start.toISOString().slice(0, 10))} — ${qlooDate(end.toISOString().slice(0, 10))}`;
}

function renderTrend(payload) {
  const result = payload.result || {};
  const title = payload.entities.join(' · ');
  $('#trendResultTitle').textContent = `${title} · ${labelType(payload.entityType)} trends`;
  $('#trendResultMeta').textContent = `Qloo trend workflow · ${payload.days} days · ${qlooDate(payload.startDate)} — ${qlooDate(payload.endDate)}`;
  const summary = result.summary || result.interpretation?.summary || result.interpretation?.text;
  const summaryBox = $('#trendSummary');
  if (summary) {
    summaryBox.textContent = String(summary);
    summaryBox.hidden = false;
  } else summaryBox.hidden = true;
  const body = $('#trendResultBody');
  if (result.status === 'empty') {
    body.innerHTML = '<div class="empty-trend"><span>◷</span><strong>No trend points were returned</strong><small>Refine the entity or select a different time range.</small></div>';
  } else {
    const payloadData = result.results ?? result.data?.results ?? result.items ?? result;
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(payloadData, null, 2);
    body.replaceChildren(pre);
  }
  $('#trendRawResponse').textContent = JSON.stringify(result, null, 2);
  $('#trendOutput').hidden = false;
  $('#trendOutput').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

$('#discoveryForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!signals.length && signalInput.value.trim()) addSignal();
  if (!signals.length) return showToast('Add at least one audience signal to get started.', 'error');
  const button = $('#submitButton');
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span><span>Finding grounded affinities…</span>';
  try {
    const payload = await requestJson('/api/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audienceName: $('#audienceName').value, signals, targetType: $('#targetType').value })
    });
    renderDiscovery(payload.item);
    await refreshHistoryCount();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>Discover audience affinities</span><span class="button-arrow">↗</span>';
  }
});

$('#addSignal').addEventListener('click', () => addSignal());
signalInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addSignal(); }
});
signalChips.addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (button) { signals.splice(Number(button.dataset.remove), 1); renderSignals(); }
});
document.querySelectorAll('[data-suggestion]').forEach(button => button.addEventListener('click', () => addSignal(button.dataset.suggestion)));

async function refreshHistoryCount() {
  try {
    const { items } = await requestJson('/api/history');
    $('#historyCount').textContent = String(items.length);
  } catch { /* History is optional to the core discovery flow. */ }
}

function showHistory(items) {
  $('#resultsSection').hidden = true;
  $('#historySection').hidden = false;
  $('#historyList').innerHTML = items.length ? items.map(item => `<button type="button" class="history-row" data-open="${escapeHtml(item.id)}"><span class="history-spark">✳</span><span class="history-copy"><strong>${escapeHtml(item.audienceName)}</strong><small>${escapeHtml(item.signals.join(' · '))}</small></span><span class="history-meta">${escapeHtml(labelType(item.targetType))} <i>·</i> ${new Date(item.createdAt).toLocaleDateString()}</span><span class="history-chevron">›</span></button>`).join('') : '<div class="empty-results"><span>◷</span><h3>No discoveries yet</h3><p>Your completed Qloo explorations will appear here.</p></div>';
  $('#historyList').onclick = async event => {
    const row = event.target.closest('[data-open]');
    if (!row) return;
    const { items: saved } = await requestJson('/api/history');
    const chosen = saved.find(x => x.id === row.dataset.open);
    if (chosen) renderDiscovery(chosen);
  };
  $('#historySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#historyNav').addEventListener('click', async () => {
  try { const { items } = await requestJson('/api/history'); showHistory(items); }
  catch (error) { showToast(error.message, 'error'); }
});
$('#newDiscovery').addEventListener('click', () => {
  $('#resultsSection').hidden = true;
  $('#historySection').hidden = true;
  $('.intro').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#helpButton').addEventListener('click', () => $('#helpDialog').showModal());
$('#closeHelp').addEventListener('click', () => $('#helpDialog').close());

$('#trendDays').addEventListener('change', updateLiveDateAndRange);
$('#trendForm').addEventListener('submit', async event => {
  event.preventDefault();
  const entities = [...new Set($('#trendEntityInput').value.split(',').map(value => value.trim()).filter(Boolean))];
  if (!entities.length) return showToast('Add at least one public entity to track.', 'error');
  if (entities.length > 5) return showToast('Track up to five entities in one Qloo trend request.', 'error');
  if (entities.some(value => value.length > 160)) return showToast('Keep each entity name to 160 characters or fewer.', 'error');
  const button = $('#trendButton');
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span><span>Loading live Qloo data…</span>';
  try {
    const payload = await requestJson('/api/trends', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities, entityType: $('#trendType').value, days: Number($('#trendDays').value) })
    });
    renderTrend(payload);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>Load live trend data</span><span>↗</span>';
  }
});

refreshHistoryCount();
updateLiveDateAndRange();
setInterval(updateLiveDateAndRange, 60_000);
