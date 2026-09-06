async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const api = {
  getState: () => apiRequest('/api/state'),
  browseDirectories: (dir = '') => apiRequest(`/api/browse-directories?path=${encodeURIComponent(dir)}`),
  applyConfig: (config) => apiRequest('/api/apply', {
    method: 'POST',
    body: JSON.stringify(config)
  }),
  onProgress: (listener) => {
    const source = new EventSource('/api/events');
    source.onmessage = (event) => {
      try { listener(JSON.parse(event.data)); } catch {}
    };
    return () => source.close();
  }
};

const rootInput = document.querySelector('#rootInput');
const browseRootBtn = document.querySelector('#browseRootBtn');
const addAllowedBtn = document.querySelector('#addAllowedBtn');
const allowedRootsList = document.querySelector('#allowedRootsList');
const emptyAllowed = document.querySelector('#emptyAllowed');
const bashWarning = document.querySelector('#bashWarning');
const applyBtn = document.querySelector('#applyBtn');
const applyLabel = applyBtn.querySelector('.button-label');
const applyTitle = document.querySelector('#applyTitle');
const applyMessage = document.querySelector('#applyMessage');
const resultBanner = document.querySelector('#resultBanner');
const statusBadge = document.querySelector('#statusBadge');
const statusText = document.querySelector('#statusText');

const folderModal = document.querySelector('#folderModal');
const folderCloseBtn = document.querySelector('#folderCloseBtn');
const folderCancelBtn = document.querySelector('#folderCancelBtn');
const folderComputerBtn = document.querySelector('#folderComputerBtn');
const folderUpBtn = document.querySelector('#folderUpBtn');
const folderPathInput = document.querySelector('#folderPathInput');
const folderGoBtn = document.querySelector('#folderGoBtn');
const folderCurrent = document.querySelector('#folderCurrent');
const folderList = document.querySelector('#folderList');
const folderError = document.querySelector('#folderError');
const folderSelectBtn = document.querySelector('#folderSelectBtn');

let allowedRoots = [];
let busy = false;
let lastStatus = null;
let folderState = { current: '', parent: null, mode: 'drives' };
let folderResolve = null;

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
}
function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}
function setResult(type, message) {
  resultBanner.hidden = !message;
  resultBanner.className = `result-banner ${type || ''}`;
  resultBanner.textContent = message || '';
}
function refreshActionCopy() {
  if (!lastStatus?.running) {
    applyLabel.textContent = '启动并应用';
    applyTitle.textContent = 'AgentDock 未运行';
    applyMessage.textContent = '点击后会按当前保存配置启动并完成核验。';
    return;
  }
  applyLabel.textContent = '确定并生效';
  if (lastStatus.matchesSaved) {
    applyTitle.textContent = '配置就绪';
    applyMessage.textContent = '核心配置优先热更新，不重启 MCP，也不打断当前 ChatGPT 对话。';
  } else {
    applyTitle.textContent = '运行配置待同步';
    applyMessage.textContent = '点击后将应用当前页面配置并完成核验。';
  }
}
function setStatus(status) {
  lastStatus = status;
  statusBadge.className = 'status-badge';
  if (!status?.running) {
    statusBadge.classList.add('status-off');
    statusText.textContent = '未运行';
    refreshActionCopy();
    return;
  }
  if (status.matchesSaved) {
    statusBadge.classList.add('status-ok');
    statusText.textContent = '运行正常';
    refreshActionCopy();
    return;
  }
  statusBadge.classList.add('status-warn');
  statusText.textContent = status.error ? '运行中 · 验证异常' : '运行中 · 待同步';
  refreshActionCopy();
}
function renderAllowedRoots() {
  allowedRootsList.replaceChildren();
  emptyAllowed.hidden = allowedRoots.length > 0;
  allowedRoots.forEach((value, index) => {
    const row = document.createElement('div');
    row.className = 'allowed-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = value;
    input.setAttribute('aria-label', `允许访问目录 ${index + 1}`);
    input.addEventListener('input', () => { allowedRoots[index] = input.value; });

    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'icon-btn';
    choose.textContent = '…';
    choose.title = '浏览目录';
    choose.addEventListener('click', async () => {
      const selected = await openFolderPicker(input.value);
      if (!selected) return;
      allowedRoots[index] = selected;
      input.value = selected;
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn remove';
    remove.textContent = '×';
    remove.title = '移除';
    remove.addEventListener('click', () => {
      allowedRoots.splice(index, 1);
      renderAllowedRoots();
    });

    row.append(input, choose, remove);
    allowedRootsList.append(row);
  });
  setControlsDisabled(busy);
}
function renderConfig(config) {
  rootInput.value = config.defaultRoot || '';
  allowedRoots = [...(config.allowedRoots || [])];
  renderAllowedRoots();
  setRadio('bashMode', config.bashMode || 'safe');
  setRadio('toolMode', config.toolMode || 'standard');
  setRadio('writeMode', config.writeMode || 'workspace');
  updateBashWarning();
}
function collectConfig() {
  return {
    defaultRoot: rootInput.value.trim(),
    allowedRoots: allowedRoots.map((item) => String(item).trim()).filter(Boolean),
    bashMode: radioValue('bashMode'),
    toolMode: radioValue('toolMode'),
    writeMode: radioValue('writeMode')
  };
}
function setControlsDisabled(disabled) {
  busy = disabled;
  rootInput.disabled = disabled;
  browseRootBtn.disabled = disabled;
  addAllowedBtn.disabled = disabled;
  document.querySelectorAll('input[type="radio"], .allowed-row input, .allowed-row button').forEach((node) => {
    node.disabled = disabled;
  });
  applyBtn.disabled = disabled;
  applyBtn.classList.toggle('busy', disabled);
}
function updateBashWarning() {
  bashWarning.hidden = radioValue('bashMode') !== 'full';
}
document.querySelectorAll('input[name="bashMode"]').forEach((input) => {
  input.addEventListener('change', updateBashWarning);
});

async function loadFolder(dir = '') {
  folderError.hidden = true;
  folderError.textContent = '';
  folderList.innerHTML = '<div class="folder-empty">读取中…</div>';
  try {
    const data = await api.browseDirectories(dir);
    folderState = { current: data.current || '', parent: data.parent ?? null, mode: data.mode || 'directory' };
    folderPathInput.value = data.current || '';
    folderCurrent.textContent = data.current ? `当前位置：${data.current}` : '请选择磁盘';
    folderUpBtn.disabled = data.mode === 'drives';
    folderSelectBtn.disabled = !data.current;
    folderList.replaceChildren();

    if (!data.directories?.length) {
      const empty = document.createElement('div');
      empty.className = 'folder-empty';
      empty.textContent = '此目录下没有子文件夹';
      folderList.append(empty);
      return;
    }

    for (const item of data.directories) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'folder-item';
      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      icon.textContent = data.mode === 'drives' ? '▣' : '📁';
      const name = document.createElement('span');
      name.className = 'folder-name';
      name.textContent = item.name;
      btn.append(icon, name);
      btn.addEventListener('click', () => loadFolder(item.path));
      folderList.append(btn);
    }
  } catch (error) {
    folderList.replaceChildren();
    folderError.hidden = false;
    folderError.textContent = error?.message || String(error);
  }
}
function closeFolderPicker(value = null) {
  folderModal.hidden = true;
  const resolve = folderResolve;
  folderResolve = null;
  if (resolve) resolve(value);
}
async function openFolderPicker(initialPath = '') {
  if (folderResolve) closeFolderPicker(null);
  folderModal.hidden = false;
  const initial = String(initialPath || '').trim();
  await loadFolder(initial || '');
  return await new Promise((resolve) => { folderResolve = resolve; });
}

folderCloseBtn.addEventListener('click', () => closeFolderPicker(null));
folderCancelBtn.addEventListener('click', () => closeFolderPicker(null));
folderComputerBtn.addEventListener('click', () => loadFolder(''));
folderUpBtn.addEventListener('click', () => loadFolder(folderState.parent || ''));
folderGoBtn.addEventListener('click', () => loadFolder(folderPathInput.value.trim()));
folderPathInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadFolder(folderPathInput.value.trim());
});
folderSelectBtn.addEventListener('click', () => {
  if (folderState.current) closeFolderPicker(folderState.current);
});
folderModal.addEventListener('click', (event) => {
  if (event.target === folderModal) closeFolderPicker(null);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !folderModal.hidden) closeFolderPicker(null);
});

browseRootBtn.addEventListener('click', async () => {
  const selected = await openFolderPicker(rootInput.value);
  if (selected) rootInput.value = selected;
});
addAllowedBtn.addEventListener('click', async () => {
  const selected = await openFolderPicker(rootInput.value);
  if (!selected) return;
  const key = selected.toLowerCase();
  if (!allowedRoots.some((item) => item.toLowerCase() === key)) allowedRoots.push(selected);
  renderAllowedRoots();
});

api.onProgress(({ stage, message }) => {
  if (stage?.startsWith('supervisor-')) {
    if (stage === 'supervisor-error') setResult('error', `后台自动恢复失败：${message}`);
    return;
  }
  applyTitle.textContent = '正在处理';
  applyMessage.textContent = message;
  setResult('info', message);
});

applyBtn.addEventListener('click', async () => {
  if (busy) return;
  setControlsDisabled(true);
  setResult('info', '正在校验配置…');
  applyTitle.textContent = '正在处理';
  applyMessage.textContent = '正在应用运行时配置；正常情况下不会重启 AgentDock。';
  statusBadge.className = 'status-badge status-loading';
  statusText.textContent = '处理中';
  try {
    const result = await api.applyConfig(collectConfig());
    renderConfig(result.config);
    setStatus(result.status);
    const message = result.hotReloaded
      ? '配置已热更新。AgentDock 与 MCP 连接没有重启，当前 ChatGPT 对话可以直接继续使用新配置。'
      : result.restarted === false
        ? '配置未变化，AgentDock 保持原连接，无需重启。'
        : 'AgentDock 原先未运行或版本不支持热更新，已通过启动/兼容流程完成配置。';
    setResult('success', message);
  } catch (error) {
    setResult('error', `应用失败：${error?.message || String(error)}`);
    try {
      const refreshed = await api.getState();
      setStatus(refreshed.status);
    } catch {
      statusBadge.className = 'status-badge status-warn';
      statusText.textContent = '状态未知';
    }
  } finally {
    setControlsDisabled(false);
    refreshActionCopy();
  }
});

async function initialize() {
  try {
    const state = await api.getState();
    renderConfig(state.config);
    setStatus(state.status);
    if (!state.status?.running) {
      setResult('info', 'AgentDock 当前未运行。Control Center 后台会自动尝试恢复，也可以点击“启动并应用”。');
    } else if (!state.status.matchesSaved) {
      const detail = state.status.error
        ? `当前 AgentDock 在运行，但实时验证未通过：${state.status.error}`
        : `当前运行配置与保存值存在差异${state.status.mismatches?.length ? `：${state.status.mismatches.join('、')}` : ''}。`;
      setResult('info', detail);
    }
  } catch (error) {
    statusBadge.className = 'status-badge status-warn';
    statusText.textContent = '读取失败';
    setResult('error', `无法读取配置：${error?.message || String(error)}`);
  }
}
initialize();
