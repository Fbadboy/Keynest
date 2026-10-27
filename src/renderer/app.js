'use strict';

// 首屏主题在脚本解析阶段就落地，避免深/浅色闪烁
document.documentElement.setAttribute(
  'data-theme',
  new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
);

/* ============================================================
   Keynest 渲染进程
   明文只存在于本进程内存中；一旦锁定立即丢弃。
   ============================================================ */

const api = window.keynest;

const ICONS = {
  chevron: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.2 4.2 10 8l-3.8 3.8"/></svg>',
  plus: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M8 3.6v8.8M3.6 8h8.8"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.6" y="5.6" width="7.2" height="7.2" rx="1.6"/><path d="M10.4 5.6V4a1.6 1.6 0 0 0-1.6-1.6H4A1.6 1.6 0 0 0 2.4 4v4.8A1.6 1.6 0 0 0 4 10.4h1.6"/></svg>',
  eye: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.8 8S4.2 4.2 8 4.2 14.2 8 14.2 8 11.8 11.8 8 11.8 1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.9"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.3 4.5A6.4 6.4 0 0 1 8 4.2c3.8 0 6.2 3.8 6.2 3.8a11 11 0 0 1-1.7 2.2M4.1 5.6A10.6 10.6 0 0 0 1.8 8s2.4 3.8 6.2 3.8c.9 0 1.7-.2 2.4-.5"/><path d="M2.6 2.6l10.8 10.8"/></svg>',
  edit: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.6 2.9l2.5 2.5-7.2 7.2-3 .5.5-3z"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.2 4.6h9.6M6.4 4.6V3.2h3.2v1.4M4.4 4.6l.6 8.2h6l.6-8.2"/></svg>',
};

const dom = {};
const state = {
  folders: [],
  entries: [],
  selectedFolderId: null,
  selectedEntryId: null,
  expanded: new Set(),
  query: '',
  view: 'empty', // empty | view | edit | create
  revealed: false,
  status: null,
  busy: false,
};

/* ─────────────── 工具 ─────────────── */

function $(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

let toastTimer = null;
function toast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 1900);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function sortByOrder(list) {
  return [...list].sort((a, b) => {
    const oa = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
    const ob = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
}

function folderById(id) {
  return state.folders.find((f) => f.id === id) || null;
}

function childrenOf(id) {
  return sortByOrder(state.folders.filter((f) => (f.parentId || null) === id));
}

function subtreeIds(id) {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of state.folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}

function folderPath(id) {
  const parts = [];
  let current = folderById(id);
  let guard = 0;
  while (current && guard++ < 32) {
    parts.unshift(current.name);
    current = current.parentId ? folderById(current.parentId) : null;
  }
  return parts.join(' / ');
}

function countInFolder(id) {
  const ids = subtreeIds(id);
  return state.entries.filter((e) => ids.has(e.folderId)).length;
}

/* ─────────────── 启动 ─────────────── */

async function boot() {
  cacheDom();
  bindGlobalEvents();
  const res = await api.status();
  state.status = res.ok ? res.data : { initialized: false };
  if (!state.status.initialized) {
    showSetup();
  } else {
    showUnlock();
  }
  api.onLocked((payload) => {
    state.folders = [];
    state.entries = [];
    state.selectedEntryId = null;
    state.view = 'empty';
    state.revealed = false;
    showUnlock(payload.reason === 'idle' ? '已闲置 10 分钟，自动锁定' : '');
  });
}

function cacheDom() {
  const ids = [
    'lock-view', 'app-view', 'lock-tagline', 'unlock-form', 'master-password', 'unlock-submit',
    'hello-btn', 'setup-form', 'setup-password', 'setup-confirm', 'strength', 'lock-msg',
    'tree', 'add-folder-btn', 'lock-btn', 'settings-btn', 'folder-title', 'folder-count',
    'new-entry-btn', 'search', 'entry-list', 'detail', 'context-menu', 'modal-layer', 'modal', 'toast',
  ];
  for (const id of ids) dom[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id);
}

function lockMessage(text, kind) {
  dom.lockMsg.textContent = text || '';
  dom.lockMsg.classList.toggle('info', kind === 'info');
}

function showSetup() {
  dom.lockView.classList.remove('hidden');
  dom.appView.classList.add('hidden');
  dom.unlockForm.classList.add('hidden');
  dom.helloBtn.classList.add('hidden');
  dom.setupForm.classList.remove('hidden');
  dom.lockTagline.textContent = '创建你的本地密码库';
  lockMessage('');
  setTimeout(() => dom.setupPassword.focus(), 60);
}

function showUnlock(info) {
  dom.lockView.classList.remove('hidden');
  dom.appView.classList.add('hidden');
  dom.setupForm.classList.add('hidden');
  dom.unlockForm.classList.remove('hidden');
  dom.lockTagline.textContent = '输入主密码解锁';
  dom.masterPassword.value = '';
  const s = state.status || {};
  const canBio = Boolean(s.biometricEnabled && s.biometricAvailable);
  dom.helloBtn.classList.toggle('hidden', !canBio);
  lockMessage(info || '', info ? 'info' : '');
  setTimeout(() => dom.masterPassword.focus(), 60);
}

async function enterApp() {
  dom.lockView.classList.add('hidden');
  dom.appView.classList.remove('hidden');
  dom.masterPassword.value = '';
  dom.setupPassword.value = '';
  dom.setupConfirm.value = '';
  dom.strength.removeAttribute('data-level');
  await refresh();
  if (!state.selectedFolderId && state.folders.length) {
    state.expanded = new Set(state.folders.map((f) => f.id));
  }
  render();
}

async function refresh() {
  const res = await api.snapshot();
  if (!res.ok) {
    if (/锁定/.test(res.error || '')) showUnlock('');
    else toast(res.error || '读取失败');
    return false;
  }
  state.folders = res.data.folders || [];
  state.entries = res.data.entries || [];
  return true;
}

/* ─────────────── 解锁流程 ─────────────── */

function setBusy(busy) {
  state.busy = busy;
  dom.unlockSubmit.disabled = busy;
  dom.helloBtn.disabled = busy;
}

async function doUnlock(password) {
  if (state.busy) return;
  if (!password) {
    lockMessage('请输入主密码');
    return;
  }
  setBusy(true);
  const res = await api.unlock(password);
  setBusy(false);
  if (!res.ok) {
    lockMessage(res.error || '解锁失败');
    dom.masterPassword.select();
    return;
  }
  lockMessage('');
  await enterApp();
}

async function doBiometric() {
  if (state.busy) return;
  setBusy(true);
  lockMessage('等待系统验证…', 'info');
  const res = await api.unlockBiometric();
  setBusy(false);
  if (!res.ok) {
    lockMessage(res.error || '验证未通过');
    return;
  }
  lockMessage('');
  await enterApp();
}

async function doSetup() {
  const password = dom.setupPassword.value;
  const confirm = dom.setupConfirm.value;
  if (password.length < 6) {
    lockMessage('主密码至少需要 6 个字符');
    return;
  }
  if (password !== confirm) {
    lockMessage('两次输入不一致');
    return;
  }
  setBusy(true);
  const res = await api.create(password);
  setBusy(false);
  if (!res.ok) {
    lockMessage(res.error || '创建失败');
    return;
  }
  state.status = { ...(state.status || {}), initialized: true };
  lockMessage('');
  await enterApp();
}

/* ─────────────── 渲染 ─────────────── */

function render() {
  renderTree();
  renderList();
  renderDetail();
  renderHeader();
}

function renderHeader() {
  const folder = state.selectedFolderId ? folderById(state.selectedFolderId) : null;
  dom.folderTitle.textContent = folder ? folder.name : '全部密码';
  const scope = state.selectedFolderId ? subtreeIds(state.selectedFolderId) : null;
  const total = scope ? state.entries.filter((e) => scope.has(e.folderId)).length : state.entries.length;
  dom.folderCount.textContent = total ? String(total) : '';
}

function renderTree() {
  dom.tree.innerHTML = '';

  const allRow = document.createElement('div');
  allRow.className = 'tree-row' + (state.selectedFolderId === null ? ' selected' : '');
  allRow.innerHTML = `<button class="twist leaf">${ICONS.chevron}</button><span class="folder-name">全部密码</span><span class="folder-count">${
    state.entries.length || ''
  }</span>`;
  allRow.addEventListener('click', () => selectFolder(null));
  dom.tree.appendChild(allRow);

  const roots = childrenOf(null);
  if (!roots.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = '还没有目录';
    dom.tree.appendChild(empty);
    return;
  }
  for (const folder of roots) appendFolderNode(dom.tree, folder, 0);
}

function appendFolderNode(container, folder, depth) {
  const children = childrenOf(folder.id);
  const row = document.createElement('div');
  row.className = 'tree-row' + (state.selectedFolderId === folder.id ? ' selected' : '');
  row.dataset.id = folder.id;
  row.style.setProperty('--depth', String(depth));

  const twist = document.createElement('button');
  twist.className = 'twist' + (children.length ? '' : ' leaf') + (state.expanded.has(folder.id) ? ' open' : '');
  twist.innerHTML = ICONS.chevron;
  twist.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFolder(folder.id);
  });

  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folder.name;

  const count = document.createElement('span');
  count.className = 'folder-count';
  const n = countInFolder(folder.id);
  count.textContent = n ? String(n) : '';

  const add = document.createElement('button');
  add.className = 'row-add';
  add.title = '新建子目录';
  add.innerHTML = ICONS.plus;
  add.addEventListener('click', (event) => {
    event.stopPropagation();
    createFolderFlow(folder.id);
  });

  row.append(twist, name, count, add);
  row.addEventListener('click', () => selectFolder(folder.id));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openFolderMenu(event, folder);
  });

  // 拖动排序：只允许在同一父级内调整，避免误改层级
  row.draggable = true;
  row.addEventListener('dragstart', (event) => beginDrag(event, folder));
  row.addEventListener('dragover', (event) => dragOverRow(event, folder));
  row.addEventListener('dragleave', (event) => {
    if (!row.contains(event.relatedTarget)) row.classList.remove('drop-before', 'drop-after');
  });
  row.addEventListener('drop', (event) => dropOnRow(event, folder));
  row.addEventListener('dragend', endDrag);

  container.appendChild(row);

  if (children.length && state.expanded.has(folder.id)) {
    for (const child of children) appendFolderNode(container, child, depth + 1);
  }
}

function toggleFolder(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderTree();
}

/* ─────────────── 目录拖动排序 ─────────────── */

const drag = { id: null, overId: null, position: null };

function clearDropMarkers() {
  dom.tree.querySelectorAll('.tree-row').forEach((row) => {
    row.classList.remove('drop-before', 'drop-after');
  });
  drag.overId = null;
  drag.position = null;
}

function beginDrag(event, folder) {
  drag.id = folder.id;
  drag.overId = null;
  drag.position = null;
  closeContextMenu();
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', folder.id);
  event.currentTarget.classList.add('dragging');
}

function dragOverRow(event, folder) {
  if (!drag.id || drag.id === folder.id) return;
  const source = folderById(drag.id);
  if (!source || (source.parentId || null) !== (folder.parentId || null)) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';

  const rect = event.currentTarget.getBoundingClientRect();
  const position = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
  if (drag.overId === folder.id && drag.position === position) return;

  clearDropMarkers();
  drag.overId = folder.id;
  drag.position = position;
  event.currentTarget.classList.add(position === 'before' ? 'drop-before' : 'drop-after');
}

async function dropOnRow(event, folder) {
  if (!drag.id || drag.id === folder.id) return;
  event.preventDefault();
  const sourceId = drag.id;
  const position = drag.position === 'after' ? 'after' : 'before';
  clearDropMarkers();
  drag.id = null;
  await commitOrder(api.reorderFolder({ id: sourceId, targetId: folder.id, position }));
}

function endDrag() {
  drag.id = null;
  clearDropMarkers();
  dom.tree.querySelectorAll('.tree-row.dragging').forEach((row) => row.classList.remove('dragging'));
}

async function commitOrder(promise) {
  const res = await promise;
  if (!res.ok) {
    toast(res.error || '调整顺序失败');
    return;
  }
  await refresh();
  render();
}

async function nudgeFolderFlow(folder, delta) {
  await commitOrder(api.nudgeFolder({ id: folder.id, delta }));
}

function selectFolder(id) {
  state.selectedFolderId = id;
  state.selectedEntryId = null;
  state.view = 'empty';
  if (id) state.expanded.add(id);
  render();
}

function visibleEntries() {
  const scope = state.selectedFolderId ? subtreeIds(state.selectedFolderId) : null;
  const query = state.query.trim().toLowerCase();
  return state.entries
    .filter((entry) => (scope ? scope.has(entry.folderId) : true))
    .filter((entry) => {
      if (!query) return true;
      return [entry.title, entry.username, entry.url, entry.notes]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(query));
    })
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'));
}

function renderList() {
  const list = visibleEntries();
  dom.entryList.innerHTML = '';

  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = state.query ? '没有匹配的密码' : '这里还没有密码';
    dom.entryList.appendChild(li);
    return;
  }

  for (const entry of list) {
    const li = document.createElement('li');
    li.className = 'entry-row' + (entry.id === state.selectedEntryId ? ' selected' : '');

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = (entry.title || '?').trim().charAt(0) || '?';

    const main = document.createElement('div');
    main.className = 'entry-main';
    const title = document.createElement('div');
    title.className = 'entry-title';
    title.textContent = entry.title;
    const sub = document.createElement('div');
    sub.className = 'entry-sub';
    sub.textContent = entry.username || entry.url || '未填写账号';
    main.append(title, sub);

    li.append(avatar, main);
    li.addEventListener('click', () => {
      state.selectedEntryId = entry.id;
      state.view = 'view';
      state.revealed = false;
      render();
    });
    dom.entryList.appendChild(li);
  }
}

function renderDetail() {
  if (state.view === 'create' || state.view === 'edit') {
    renderForm();
    return;
  }
  const entry = state.entries.find((e) => e.id === state.selectedEntryId);
  if (!entry) {
    state.view = 'empty';
    dom.detail.innerHTML = '<div class="detail-empty">选择左侧的密码查看详情</div>';
    return;
  }

  const path = entry.folderId ? folderPath(entry.folderId) : '未分类';
  const rows = [];

  rows.push(fieldRow('账号', entry.username, { mono: true }));
  rows.push(passwordRow(entry.password));
  if (entry.url) rows.push(fieldRow('网址', entry.url, { mono: true }));
  if (entry.notes) rows.push(fieldRow('备注', entry.notes));

  dom.detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h1 class="detail-title">${esc(entry.title)}</h1>
        <p class="detail-path">${esc(path)}</p>
      </div>
      <div class="detail-actions">
        <button class="icon-btn" data-act="edit" title="编辑">${ICONS.edit}</button>
        <button class="icon-btn" data-act="delete" title="删除">${ICONS.trash}</button>
      </div>
    </div>
    ${rows.join('')}
  `;

  dom.detail.querySelector('[data-act="edit"]').addEventListener('click', () => {
    state.view = 'edit';
    state.revealed = false;
    render();
  });
  dom.detail.querySelector('[data-act="delete"]').addEventListener('click', () => deleteEntryFlow(entry));

  dom.detail.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const secret = btn.dataset.secret === '1';
      api.copy({ value: btn.dataset.copy, secret }).then((res) => {
        if (!res.ok) {
          toast(res.error || '复制失败');
          return;
        }
        const seconds = res.data && res.data.clearSeconds;
        toast(secret && seconds ? `已复制，${seconds} 秒后自动清除` : '已复制');
      });
    });
  });

  const revealBtn = dom.detail.querySelector('[data-reveal]');
  if (revealBtn) {
    revealBtn.addEventListener('click', () => {
      state.revealed = !state.revealed;
      renderDetail();
    });
  }
}

function fieldRow(label, value, options = {}) {
  const has = Boolean(value);
  const cls = ['field-value', options.mono ? 'mono' : '', has ? '' : 'empty'].filter(Boolean).join(' ');
  const tools = has
    ? `<div class="field-tools"><button class="icon-btn" data-copy="${esc(value)}" title="复制">${ICONS.copy}</button></div>`
    : '';
  return `<div class="field">
      <div class="field-label">${label}</div>
      <div class="field-body">
        <div class="${cls}">${has ? esc(value) : '—'}</div>
        ${tools}
      </div>
    </div>`;
}

function passwordRow(password) {
  if (!password) {
    return `<div class="field">
      <div class="field-label">密码</div>
      <div class="field-body"><div class="field-value empty">—</div></div>
    </div>`;
  }
  const shown = state.revealed
    ? `<div class="field-value mono">${esc(password)}</div>`
    : `<div class="field-value secret">${'•'.repeat(Math.min(password.length, 18))}</div>`;
  return `<div class="field">
      <div class="field-label">密码</div>
      <div class="field-body">
        ${shown}
        <div class="field-tools always">
          <button class="icon-btn" data-reveal title="${state.revealed ? '隐藏' : '显示'}">${
    state.revealed ? ICONS.eyeOff : ICONS.eye
  }</button>
          <button class="icon-btn" data-copy="${esc(password)}" data-secret="1" title="复制">${ICONS.copy}</button>
        </div>
      </div>
    </div>`;
}

function folderOptions(selectedId) {
  const out = [`<option value="">未分类</option>`];
  const walk = (parentId, depth) => {
    for (const folder of childrenOf(parentId)) {
      const prefix = depth ? '　'.repeat(depth) + '└ ' : '';
      out.push(
        `<option value="${esc(folder.id)}" ${folder.id === selectedId ? 'selected' : ''}>${esc(prefix + folder.name)}</option>`
      );
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out.join('');
}

function renderForm() {
  const isEdit = state.view === 'edit';
  const entry = isEdit ? state.entries.find((e) => e.id === state.selectedEntryId) : null;
  if (isEdit && !entry) {
    state.view = 'empty';
    renderDetail();
    return;
  }
  const draft = entry || {
    title: '',
    username: '',
    password: '',
    url: '',
    notes: '',
    folderId: state.selectedFolderId || '',
  };

  dom.detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h1 class="detail-title">${isEdit ? '编辑密码' : '新建密码'}</h1>
        <p class="detail-path">${isEdit ? esc(draft.folderId ? folderPath(draft.folderId) : '未分类') : '填写后保存'}</p>
      </div>
    </div>
    <form class="detail-form" id="entry-form" autocomplete="off">
      <div class="form-row">
        <label for="f-title">名称</label>
        <input class="input" id="f-title" maxlength="80" placeholder="例如：Gmail" value="${esc(draft.title)}" />
      </div>
      <div class="form-row">
        <label for="f-username">账号</label>
        <input class="input" id="f-username" placeholder="用户名 / 邮箱" value="${esc(draft.username)}" />
      </div>
      <div class="form-row">
        <label for="f-password">密码</label>
        <input class="input mono" id="f-password" type="password" autocomplete="new-password" placeholder="密码内容" value="${esc(
          draft.password
        )}" />
      </div>
      <div class="form-row">
        <label for="f-url">网址</label>
        <input class="input" id="f-url" placeholder="https://" value="${esc(draft.url)}" />
      </div>
      <div class="form-row">
        <label for="f-folder">目录</label>
        <select class="input" id="f-folder">${folderOptions(draft.folderId || '')}</select>
      </div>
      <div class="form-row">
        <label for="f-notes">备注</label>
        <textarea class="input" id="f-notes" maxlength="8192" placeholder="可选">${esc(draft.notes)}</textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="f-cancel">取消</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>
  `;

  const titleInput = $('f-title');
  setTimeout(() => titleInput.focus(), 30);

  $('f-cancel').addEventListener('click', () => {
    state.view = entry ? 'view' : 'empty';
    render();
  });

  $('entry-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      title: $('f-title').value.trim(),
      username: $('f-username').value,
      password: $('f-password').value,
      url: $('f-url').value.trim(),
      notes: $('f-notes').value,
      folderId: $('f-folder').value || null,
    };
    if (!payload.title) {
      toast('请填写名称');
      titleInput.focus();
      return;
    }
    const res = isEdit
      ? await api.updateEntry({ id: entry.id, patch: payload })
      : await api.createEntry(payload);
    if (!res.ok) {
      toast(res.error || '保存失败');
      return;
    }
    await refresh();
    state.selectedEntryId = res.data.id;
    state.selectedFolderId = res.data.folderId || null;
    if (res.data.folderId) {
      let parent = folderById(res.data.folderId);
      while (parent) {
        state.expanded.add(parent.id);
        parent = parent.parentId ? folderById(parent.parentId) : null;
      }
    }
    state.view = 'view';
    render();
    toast(isEdit ? '已保存' : '已创建');
  });
}

/* ─────────────── 目录操作 ─────────────── */

function openFolderMenu(event, folder) {
  const siblings = childrenOf(folder.parentId || null);
  const index = siblings.findIndex((f) => f.id === folder.id);
  const items = [
    { label: '新建子目录', act: () => createFolderFlow(folder.id) },
    { label: '重命名', act: () => renameFolderFlow(folder) },
    { label: '移动到…', act: () => moveFolderFlow(folder) },
    { sep: true },
    { label: '上移', disabled: index <= 0, act: () => nudgeFolderFlow(folder, -1) },
    {
      label: '下移',
      disabled: index < 0 || index >= siblings.length - 1,
      act: () => nudgeFolderFlow(folder, 1),
    },
    { sep: true },
    { label: '删除目录', danger: true, act: () => deleteFolderFlow(folder) },
  ];
  openContextMenu(event.clientX, event.clientY, items);
}

function openContextMenu(x, y, items) {
  const menu = dom.contextMenu;
  menu.innerHTML = '';
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'menu-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
    el.textContent = item.label;
    if (item.disabled) {
      el.setAttribute('aria-disabled', 'true');
    } else {
      el.addEventListener('click', () => {
        closeContextMenu();
        item.act();
      });
    }
    menu.appendChild(el);
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function closeContextMenu() {
  dom.contextMenu.classList.add('hidden');
}

async function createFolderFlow(parentId) {
  const parent = parentId ? folderById(parentId) : null;
  const name = await promptModal({
    title: parent ? `在「${parent.name}」下新建目录` : '新建目录',
    placeholder: '目录名称',
    confirmText: '创建',
  });
  if (name === null) return;
  const res = await api.createFolder({ name, parentId: parentId || null });
  if (!res.ok) {
    toast(res.error || '创建失败');
    return;
  }
  if (parentId) state.expanded.add(parentId);
  state.selectedFolderId = res.data.id;
  await refresh();
  render();
}

async function renameFolderFlow(folder) {
  const name = await promptModal({
    title: '重命名目录',
    value: folder.name,
    confirmText: '保存',
  });
  if (name === null || name === folder.name) return;
  const res = await api.renameFolder({ id: folder.id, name });
  if (!res.ok) {
    toast(res.error || '重命名失败');
    return;
  }
  await refresh();
  render();
}

async function moveFolderFlow(folder) {
  const blocked = subtreeIds(folder.id);
  const currentParent = folder.parentId || null;

  const item = (id, name, isCurrent) => `
    <button
      class="move-item${isCurrent ? ' current' : ''}"
      data-id="${esc(id)}"
      ${isCurrent ? 'disabled' : ''}
    >
      <span class="move-name">${esc(name)}</span>
      ${isCurrent ? '<span class="move-tag">当前位置</span>' : ''}
    </button>`;

  // 用嵌套结构还原层级，靠左侧竖线串起父子关系
  const renderChildren = (parentId) => {
    const kids = childrenOf(parentId).filter((f) => !blocked.has(f.id));
    if (!kids.length) return '';
    return kids
      .map((child) => {
        const grand = renderChildren(child.id);
        return `<div class="move-node">${item(child.id, child.name, child.id === currentParent)}${
          grand ? `<div class="move-children">${grand}</div>` : ''
        }</div>`;
      })
      .join('');
  };

  const tree = renderChildren(null);

  const modal = openModal(`
    <h3>移动「${esc(folder.name)}」</h3>
    <p class="modal-desc">选择目标位置，该目录及其所有子目录会一起移动。</p>
    <div class="move-list" id="move-list">
      <div class="move-node">${item('', '根目录（顶层）', currentParent === null)}</div>
      ${tree ? `<div class="move-children">${tree}</div>` : ''}
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok" disabled>移动</button>
    </div>
  `);

  const okBtn = modal.querySelector('#m-ok');
  let selected = null;

  modal.querySelectorAll('.move-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      modal.querySelectorAll('.move-item').forEach((el) => el.classList.remove('selected'));
      btn.classList.add('selected');
      selected = btn.dataset.id;
      okBtn.disabled = false;
    });
  });

  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  okBtn.addEventListener('click', async () => {
    if (selected === null) return;
    okBtn.disabled = true;
    const res = await api.moveFolder({ id: folder.id, parentId: selected || null });
    if (!res.ok) {
      okBtn.disabled = false;
      toast(res.error || '移动失败');
      return;
    }
    closeModal();
    await refresh();
    // 展开新的上级路径，让移动后的目录可见
    let parent = folderById(folder.id);
    while (parent && parent.parentId) {
      state.expanded.add(parent.parentId);
      parent = folderById(parent.parentId);
    }
    state.selectedFolderId = folder.id;
    state.selectedEntryId = null;
    render();
    toast(`已移动到「${selected ? folderPath(selected) : '根目录'}」`);
  });
}

async function deleteFolderFlow(folder) {
  const ids = subtreeIds(folder.id);
  const subCount = ids.size - 1;
  const entryCount = state.entries.filter((e) => ids.has(e.folderId)).length;
  const detail = [
    subCount ? `${subCount} 个子目录` : '',
    entryCount ? `${entryCount} 个密码` : '',
  ]
    .filter(Boolean)
    .join('、');
  const confirmed = await confirmModal({
    title: `删除「${folder.name}」`,
    desc: detail ? `将同时删除其中的 ${detail}，此操作无法撤销。` : '此操作无法撤销。',
    confirmText: '删除',
    danger: true,
  });
  if (!confirmed) return;
  const res = await api.deleteFolder({ id: folder.id });
  if (!res.ok) {
    toast(res.error || '删除失败');
    return;
  }
  if (state.selectedFolderId && ids.has(state.selectedFolderId)) {
    state.selectedFolderId = null;
  }
  if (state.selectedEntryId) {
    const stillThere = state.entries.find((e) => e.id === state.selectedEntryId && !ids.has(e.folderId));
    if (!stillThere) {
      state.selectedEntryId = null;
      state.view = 'empty';
    }
  }
  await refresh();
  render();
  toast('已删除');
}

async function deleteEntryFlow(entry) {
  const confirmed = await confirmModal({
    title: `删除「${entry.title}」`,
    desc: '该密码将从密码库中永久移除，此操作无法撤销。',
    confirmText: '删除',
    danger: true,
  });
  if (!confirmed) return;
  const res = await api.deleteEntry({ id: entry.id });
  if (!res.ok) {
    toast(res.error || '删除失败');
    return;
  }
  state.selectedEntryId = null;
  state.view = 'empty';
  await refresh();
  render();
  toast('已删除');
}

/* ─────────────── 弹层 ─────────────── */

function openModal(html) {
  dom.modal.innerHTML = html;
  dom.modalLayer.classList.remove('hidden');
  return dom.modal;
}

function closeModal() {
  dom.modalLayer.classList.add('hidden');
  dom.modal.innerHTML = '';
}

function promptModal({ title, desc, value = '', placeholder = '', confirmText = '确定' }) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h3>${esc(title)}</h3>
      ${desc ? `<p class="modal-desc">${esc(desc)}</p>` : '<div class="modal-gap"></div>'}
      <input class="input" id="m-input" maxlength="80" placeholder="${esc(placeholder)}" value="${esc(value)}" />
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">取消</button>
        <button class="btn btn-primary" id="m-ok">${esc(confirmText)}</button>
      </div>
    `);
    const input = modal.querySelector('#m-input');
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);

    const done = (result) => {
      closeModal();
      resolve(result);
    };
    const submit = () => {
      const next = input.value.trim();
      if (!next) {
        input.focus();
        return;
      }
      done(next);
    };
    modal.querySelector('#m-ok').addEventListener('click', submit);
    modal.querySelector('#m-cancel').addEventListener('click', () => done(null));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  });
}

function confirmModal({ title, desc, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h3>${esc(title)}</h3>
      <p class="modal-desc">${esc(desc)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="m-ok">${esc(confirmText)}</button>
      </div>
    `);
    const done = (result) => {
      closeModal();
      resolve(result);
    };
    modal.querySelector('#m-ok').addEventListener('click', () => done(true));
    modal.querySelector('#m-cancel').addEventListener('click', () => done(false));
    modal.querySelector('#m-ok').focus();
  });
}

async function openSettings() {
  const s = state.status || {};
  const bioAvailable = Boolean(s.biometricAvailable);
  const bioOn = Boolean(s.biometricEnabled);

  const res = await api.getSettings();
  if (!res.ok) {
    toast(res.error || '读取设置失败');
    return;
  }
  const settings = res.data;
  const clipLimits = settings.limits.clipboardClearSeconds;

  const modal = openModal(`
    <h3>设置</h3>
    <p class="modal-desc">密码库以 AES-256-GCM 加密后仅保存在本机。</p>
    <div class="setting-row">
      <div class="setting-text">
        <strong>界面主题</strong>
        <span>深色适合弱光，浅色适合明亮环境</span>
      </div>
      <div class="segmented" id="theme-seg">
        <button class="seg-btn ${settings.theme === 'dark' ? 'active' : ''}" data-theme="dark">深色</button>
        <button class="seg-btn ${settings.theme === 'light' ? 'active' : ''}" data-theme="light">浅色</button>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-text">
        <strong>Windows Hello 解锁</strong>
        <span>${bioAvailable ? '使用指纹 / 面容 / PIN 快速解锁' : esc(s.biometricReason || '当前不可用')}</span>
      </div>
      <button class="switch ${bioOn ? 'on' : ''}" id="bio-switch" ${bioAvailable ? '' : 'disabled'} aria-label="Windows Hello 解锁"></button>
    </div>
    <div class="setting-row">
      <div class="setting-text">
        <strong>剪贴板自动清除</strong>
        <span>复制密码后多少秒清空剪贴板（${clipLimits.min}–${clipLimits.max}）</span>
      </div>
      <div class="setting-input">
        <input
          class="input input-sm"
          id="clip-seconds"
          type="number"
          inputmode="numeric"
          min="${clipLimits.min}"
          max="${clipLimits.max}"
          step="1"
          value="${settings.clipboardClearSeconds}"
          aria-label="剪贴板自动清除秒数"
        />
        <span class="unit">秒</span>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-text">
        <strong>闲置自动锁定</strong>
        <span>无操作 10 分钟后自动锁定</span>
      </div>
    </div>
    <div class="setting-row no-line">
      <div class="setting-text">
        <strong>修改主密码</strong>
        <span>将以新密钥重新加密密码库</span>
      </div>
      <button class="btn btn-ghost" id="change-pw">修改</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-close">关闭</button>
    </div>
  `);

  const seg = modal.querySelector('#theme-seg');
  seg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.theme;
      if (next === settings.theme) return;
      const result = await api.updateSettings({ theme: next });
      if (!result.ok) {
        toast(result.error || '保存失败');
        return;
      }
      settings.theme = result.data.theme;
      applyTheme(settings.theme);
      seg
        .querySelectorAll('.seg-btn')
        .forEach((item) => item.classList.toggle('active', item.dataset.theme === settings.theme));
    });
  });

  const sw = modal.querySelector('#bio-switch');
  sw.addEventListener('click', async () => {
    if (!bioAvailable) return;
    const next = !sw.classList.contains('on');
    sw.disabled = true;
    const result = await api.setBiometric(next);
    sw.disabled = false;
    if (!result.ok) {
      toast(result.error || '操作失败');
      return;
    }
    sw.classList.toggle('on', Boolean(result.data.biometricEnabled));
    state.status = { ...(state.status || {}), biometricEnabled: result.data.biometricEnabled };
    toast(result.data.biometricEnabled ? '已启用生物识别解锁' : '已关闭生物识别解锁');
  });

  const clipInput = modal.querySelector('#clip-seconds');
  const commitClipSeconds = async () => {
    const raw = clipInput.value.trim();
    const result = await api.updateSettings({
      clipboardClearSeconds: raw === '' ? null : Number(raw),
    });
    if (!result.ok) {
      toast(result.error || '保存失败');
      clipInput.value = String(settings.clipboardClearSeconds);
      return;
    }
    settings.clipboardClearSeconds = result.data.clipboardClearSeconds;
    clipInput.value = String(result.data.clipboardClearSeconds);
    toast(`已保存：${result.data.clipboardClearSeconds} 秒后自动清除`);
  };
  clipInput.addEventListener('change', commitClipSeconds);
  clipInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clipInput.blur();
    }
  });

  modal.querySelector('#change-pw').addEventListener('click', () => {
    closeModal();
    openChangePassword();
  });
  modal.querySelector('#m-close').addEventListener('click', closeModal);
}

function openChangePassword() {
  const modal = openModal(`
    <h3>修改主密码</h3>
    <p class="modal-desc">修改后需使用新密码解锁；已启用的 Windows Hello 会自动同步。</p>
    <input class="input" id="p-current" type="password" placeholder="当前主密码" autocomplete="current-password" />
    <input class="input" id="p-next" type="password" placeholder="新主密码（至少 6 位）" autocomplete="new-password" />
    <input class="input" id="p-confirm" type="password" placeholder="再次输入新主密码" autocomplete="new-password" />
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">确认修改</button>
    </div>
  `);
  setTimeout(() => modal.querySelector('#p-current').focus(), 30);

  modal.querySelector('#m-cancel').addEventListener('click', closeModal);
  modal.querySelector('#m-ok').addEventListener('click', async () => {
    const current = modal.querySelector('#p-current').value;
    const next = modal.querySelector('#p-next').value;
    const confirm = modal.querySelector('#p-confirm').value;
    if (!current) return toast('请输入当前主密码');
    if (next.length < 6) return toast('新主密码至少需要 6 个字符');
    if (next !== confirm) return toast('两次输入不一致');
    const res = await api.changePassword({ current, next });
    if (!res.ok) return toast(res.error || '修改失败');
    closeModal();
    toast('主密码已更新');
  });
}

/* ─────────────── 事件绑定 ─────────────── */

function bindGlobalEvents() {
  dom.unlockForm.addEventListener('submit', (event) => {
    event.preventDefault();
    doUnlock(dom.masterPassword.value);
  });

  dom.helloBtn.addEventListener('click', doBiometric);

  dom.setupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    doSetup();
  });

  dom.setupPassword.addEventListener('input', () => {
    const value = dom.setupPassword.value;
    let level = 0;
    if (value.length >= 6) level = 1;
    if (value.length >= 10 && /[a-zA-Z]/.test(value) && /[0-9\W]/.test(value)) level = 2;
    if (value.length >= 14 && /[a-zA-Z]/.test(value) && /[0-9]/.test(value) && /[^a-zA-Z0-9]/.test(value)) level = 3;
    dom.strength.setAttribute('data-level', String(level));
  });

  dom.addFolderBtn.addEventListener('click', () => createFolderFlow(state.selectedFolderId));
  dom.newEntryBtn.addEventListener('click', () => {
    state.view = 'create';
    state.selectedEntryId = null;
    render();
  });
  dom.lockBtn.addEventListener('click', () => api.lock());
  dom.settingsBtn.addEventListener('click', openSettings);

  dom.search.addEventListener('input', () => {
    state.query = dom.search.value;
    renderList();
  });

  dom.modalLayer.addEventListener('click', (event) => {
    if (event.target === dom.modalLayer) closeModal();
  });

  document.addEventListener('click', (event) => {
    if (!dom.contextMenu.contains(event.target)) closeContextMenu();
  });
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);

  // 拖到树外面时清掉插入位置提示
  dom.tree.addEventListener('dragleave', (event) => {
    if (!dom.tree.contains(event.relatedTarget)) clearDropMarkers();
  });
  dom.tree.addEventListener('drop', (event) => event.preventDefault());

  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      if (!dom.appView.classList.contains('hidden')) api.lock();
      return;
    }
    if (mod && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      if (!dom.appView.classList.contains('hidden')) {
        state.view = 'create';
        state.selectedEntryId = null;
        render();
      }
      return;
    }
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (!dom.appView.classList.contains('hidden')) dom.search.focus();
      return;
    }
    if (event.key === 'Escape') {
      if (!dom.modalLayer.classList.contains('hidden')) {
        closeModal();
        return;
      }
      closeContextMenu();
      if (state.view === 'create' || state.view === 'edit') {
        state.view = state.selectedEntryId ? 'view' : 'empty';
        render();
      } else if (document.activeElement === dom.search && dom.search.value) {
        dom.search.value = '';
        state.query = '';
        renderList();
      }
    }
  });

  // 用户活动 → 续期自动锁定计时
  let lastTouch = 0;
  const touch = () => {
    if (dom.appView.classList.contains('hidden')) return;
    const now = Date.now();
    if (now - lastTouch < 20000) return;
    lastTouch = now;
    api.touch();
  };
  for (const type of ['mousemove', 'keydown', 'click', 'wheel']) {
    document.addEventListener(type, touch, { passive: true });
  }
}

boot();
