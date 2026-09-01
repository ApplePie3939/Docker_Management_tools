const $ = (selector) => document.querySelector(selector);
let containers = [];
let pendingAction;
let actionSubmitting = false;
const labels = { start: '起動', stop: '停止', restart: '再起動' };

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw data.error || { message: '要求に失敗しました。' };
  return data;
}
function escape(value = '') { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }
function stateLabel(state) { return ({ running: '起動中', exited: '停止中', created: '作成済み', paused: '一時停止', restarting: '再起動中' })[state] || state; }
function ports(items = []) { return items.length ? items.map(p => p.publicPort ? `${p.ip ? `${p.ip}:` : ''}${p.publicPort} → ${p.privatePort}/${p.type}` : `${p.privatePort}/${p.type}`).join(', ') : '—'; }
function toast(message, kind = 'success') { const el = $('#toast'); el.textContent = message; el.className = `show ${kind}`; setTimeout(() => el.className = '', 4500); }

async function refresh() {
  $('#connection').className = 'connection loading'; $('#connection').textContent = 'Docker Engine に接続を確認しています…';
  try {
    const dashboard = await request('/api/dashboard');
    $('#running').textContent = dashboard.running; $('#stopped').textContent = dashboard.stopped;
    if (dashboard.connected) { $('#connection').className = 'connection ok'; $('#connection').innerHTML = '<strong>● 接続済み</strong><span>ローカル Docker Engine に安全に接続しています。</span>'; }
    else {
      $('#connection').className = 'connection error'; $('#connection').innerHTML = `<strong>● 接続できません</strong><span>${escape(dashboard.error.message)}<br>${escape(dashboard.error.guidance)}</span>`;
      containers = []; renderContainers();
    }
    const history = await request('/api/history'); renderHistory(history);
    if (dashboard.connected) { containers = await request('/api/containers'); renderContainers(); }
  } catch (error) {
    $('#connection').className = 'connection error'; $('#connection').innerHTML = `<strong>● 情報を取得できません</strong><span>${escape(error.message || 'バックエンドが起動しているか確認してください。')}</span>`;
    $('#containers').innerHTML = '<tr><td colspan="5">コンテナ情報を取得できませんでした。</td></tr>';
  }
}
function renderContainers() {
  const state = $('#state-filter').value;
  const filtered = state === 'all' ? containers : containers.filter(c => c.state === state || (state === 'exited' && c.state !== 'running'));
  $('#containers').innerHTML = filtered.length ? filtered.map(c => `<tr><td><button class="link detail" data-id="${c.id}">${escape(c.name)}</button></td><td>${escape(c.image)}</td><td><span class="badge ${escape(c.state)}">${escape(stateLabel(c.state))}</span><small>${escape(c.status)}</small></td><td>${escape(ports(c.ports))}</td><td class="actions"><button class="small action" data-id="${c.id}" data-action="start" ${c.state === 'running' ? 'disabled' : ''}>起動</button><button class="small secondary action" data-id="${c.id}" data-action="stop" ${c.state !== 'running' ? 'disabled' : ''}>停止</button><button class="small secondary action" data-id="${c.id}" data-action="restart" ${c.state !== 'running' ? 'disabled' : ''}>再起動</button></td></tr>`).join('') : '<tr><td colspan="5">条件に合うコンテナはありません。</td></tr>';
}
function renderHistory(history) {
  $('#history').innerHTML = history.length ? history.map(h => `<article><span class="result ${h.success ? 'success' : 'failed'}">${h.success ? '成功' : '失敗'}</span><div><strong>${escape(h.containerName)}</strong> を${escape(labels[h.action] || h.action)}<p>${escape(h.message)}</p></div><time>${new Date(h.at).toLocaleString('ja-JP')}</time></article>`).join('') : '<p class="empty">操作履歴はまだありません。</p>';
}
async function showDetails(id) {
  const dialog = $('#details'); $('#detail-content').innerHTML = '<p>詳細を取得中…</p>'; dialog.showModal();
  try {
    const [detail, logData] = await Promise.all([request(`/api/containers/${id}`), request(`/api/containers/${id}/logs`)]);
    const rows = (items, formatter) => items.length ? `<ul>${items.map(formatter).join('')}</ul>` : '<p>設定なし</p>';
    $('#detail-content').innerHTML = `<p class="eyebrow">CONTAINER DETAIL</p><h2>${escape(detail.name)}</h2><p class="muted">${escape(detail.image)} · ${escape(stateLabel(detail.state))}</p><h3>環境変数</h3>${rows(detail.environment, x => `<li><code>${escape(x)}</code></li>`)}<h3>ポート設定</h3>${rows(detail.ports, p => `<li><code>${escape(`${p.hostIp ? p.hostIp + ':' : ''}${p.hostPort} → ${p.containerPort}`)}</code></li>`)}<h3>マウント設定</h3>${rows(detail.mounts, m => `<li><code>${escape(`${m.type}: ${m.source} → ${m.destination}${m.writable ? '' : ' (read-only)'}`)}</code></li>`)}<h3>ログ（直近500行）</h3><pre>${escape(logData.logs || 'ログはありません。')}</pre>`;
  } catch (error) { $('#detail-content').innerHTML = `<h2>詳細を取得できません</h2><p>${escape(error.message)}</p><p>${escape(error.guidance || '')}</p>`; }
}
function askAction(id, action) {
  if (actionSubmitting) { toast('別の操作を実行中です。完了するまでお待ちください。', 'error'); return; }
  const container = containers.find(c => c.id === id);
  if (!container || !labels[action]) return;
  pendingAction = { id, action };
  actionSubmitting = false;
  $('#confirm-run').disabled = false;
  $('#confirm-cancel').disabled = false;
  $('#confirm-run').textContent = '実行する';
  $('#confirm-title').textContent = `${labels[action]}を確認`;
  $('#confirm-text').textContent = `コンテナ「${container.name}」を${labels[action]}します。よろしいですか？`;
  $('#confirm').showModal();
  $('#confirm-cancel').focus();
}
document.addEventListener('click', async (event) => {
  const target = event.target;
  if (target.matches('.detail')) showDetails(target.dataset.id);
  if (target.matches('.action')) askAction(target.dataset.id, target.dataset.action);
  if (target.matches('.close')) target.closest('dialog').close();
});
$('#confirm-cancel').addEventListener('click', () => $('#confirm').close('cancel'));
$('#confirm').addEventListener('close', () => {
  pendingAction = undefined;
});
$('#confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (actionSubmitting || !pendingAction) return;
  const { id, action } = pendingAction;
  actionSubmitting = true;
  pendingAction = undefined;
  $('#confirm-run').disabled = true;
  $('#confirm-cancel').disabled = true;
  $('#confirm-run').textContent = '実行中…';
  $('#confirm').close('confirmed');
  try {
    const result = await request(`/api/containers/${id}/actions/${action}`, { method: 'POST' });
    toast(result.historyRecorded === false ? `${result.message} ${result.historyWarning}` : result.message, result.historyRecorded === false ? 'error' : 'success');
    await refresh();
  }
  catch (error) { toast(`${error.message} ${error.guidance || ''}`, 'error'); await refresh(); }
  finally { actionSubmitting = false; }
});
$('#state-filter').addEventListener('change', renderContainers);
$('#refresh').addEventListener('click', refresh);
refresh();
