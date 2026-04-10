/**
 * Request Wizard — Options Page Logic
 *
 * Two-tier save model:
 *   - DRAFT:   Every edit auto-persists to chrome.storage.local (won't be lost
 *              if the page closes) but does NOT broadcast to tabs — rules stay
 *              inactive until published.
 *   - PUBLISH: Clicking "Save & Apply" or pressing Ctrl/Cmd+S persists AND
 *              broadcasts to all tabs so the interceptor picks up the changes.
 *
 * The dirty-dot indicator shows when there are unpublished draft changes.
 */
(function () {
  'use strict';

  let data = null;
  let selectedGroupId = null;
  let draftTimer = null;
  let isDirty = false; // true when draft ≠ last-published

  const expandedRules = new Set();
  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
  const PENCIL = '<svg class="edit-hint-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>';

  // ─── DOM refs ──────────────────────────────────────────
  const $ = s => document.querySelector(s);
  const globalToggle   = $('#globalToggle');
  const globalLabel    = $('#globalLabel');
  const debugToggle    = $('#debugToggle');
  const groupList      = $('#groupList');
  const emptyState     = $('#emptyState');
  const groupEditor    = $('#groupEditor');
  const geGroupName    = $('#geGroupName');
  const geGroupEnabled = $('#geGroupEnabled');
  const rulesList      = $('#rulesList');
  const btnAddGroup    = $('#btnAddGroup');
  const btnAddRule     = $('#btnAddRule');
  const btnDeleteGroup = $('#btnDeleteGroup');
  const btnPublish     = $('#btnPublish');
  const dirtyDot       = $('#dirtyDot');
  const btnImport      = $('#btnImport');
  const btnExport      = $('#btnExport');
  const fileInput      = $('#fileInput');
  const toastContainer = $('#toastContainer');
  const mainPanel      = $('#mainPanel');

  // ─── Messaging ─────────────────────────────────────────
  function sendMsg(type, payload) {
    return new Promise(r => chrome.runtime.sendMessage({ type, payload }, r));
  }
  function gid() { return 'rw_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

  // ─── Draft save (auto, debounced) — persist only ───────
  function draftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => sendMsg('RW_DRAFT_DATA', data), 300);
    setDirty(true);
  }
  function draftSaveNow() {
    clearTimeout(draftTimer);
    sendMsg('RW_DRAFT_DATA', data);
    setDirty(true);
  }

  // ─── Publish (explicit) — persist + broadcast ──────────
  async function publish() {
    clearTimeout(draftTimer);
    await sendMsg('RW_PUBLISH_DATA', data);
    setDirty(false);
    toast('Saved & applied');
  }

  function setDirty(v) {
    isDirty = v;
    dirtyDot.classList.toggle('visible', v);
    btnPublish.classList.toggle('has-changes', v);
  }

  // ─── Scroll-preserving re-render ───────────────────────
  function rerenderKeepScroll(ruleId) {
    const top = mainPanel.scrollTop;
    if (ruleId) expandedRules.add(ruleId);
    renderGroupEditor();
    requestAnimationFrame(() => { mainPanel.scrollTop = top; });
  }

  // ─── Toast ─────────────────────────────────────────────
  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ─── Confirm dialog ────────────────────────────────────
  function confirmAction(message) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'confirm-overlay';
      ov.innerHTML = `<div class="confirm-dialog">
        <div class="confirm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div class="confirm-message">${message}</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost confirm-cancel">Cancel</button>
          <button class="btn btn-danger confirm-ok">Delete</button>
        </div>
      </div>`;
      document.body.appendChild(ov);
      requestAnimationFrame(() => ov.classList.add('visible'));
      const done = v => { ov.classList.remove('visible'); setTimeout(() => ov.remove(), 200); resolve(v); };
      ov.querySelector('.confirm-cancel').onclick = () => done(false);
      ov.querySelector('.confirm-ok').onclick = () => done(true);
      ov.addEventListener('click', e => { if (e.target === ov) done(false); });
      const onKey = e => { if (e.key === 'Escape') { done(false); document.removeEventListener('keydown', onKey); } };
      document.addEventListener('keydown', onKey);
    });
  }

  // ─── Init ──────────────────────────────────────────────
  async function init() {
    data = await sendMsg('RW_GET_DATA');
    if (data.debugLog === undefined) data.debugLog = false;
    bindEvents();
    render();
    setDirty(false);
  }

  // ─── Events ────────────────────────────────────────────
  function bindEvents() {
    // Global enable
    globalToggle.addEventListener('change', () => {
      data.globalEnabled = globalToggle.checked;
      globalLabel.textContent = data.globalEnabled ? 'Enabled' : 'Disabled';
      draftSaveNow();
    });

    // Debug log toggle
    debugToggle.addEventListener('change', () => {
      data.debugLog = debugToggle.checked;
      draftSaveNow();
    });

    // Publish button
    btnPublish.addEventListener('click', () => publish());

    // Ctrl/Cmd+S → publish + collapse
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        expandedRules.clear();
        renderGroupEditor();
        publish();
      }
    });

    btnAddGroup.addEventListener('click', () => {
      data.ruleGroups.push({ id: gid(), name: 'New Group', enabled: true, rules: [] });
      selectedGroupId = data.ruleGroups[data.ruleGroups.length - 1].id;
      draftSaveNow();
      render();
      toast('Group created', 'info');
    });

    btnAddRule.addEventListener('click', () => {
      const g = getGroup(); if (!g) return;
      const rule = defaultRule();
      g.rules.push(rule);
      expandedRules.add(rule.id);
      draftSaveNow();
      renderGroupEditor();
      setTimeout(() => { const c = rulesList.querySelectorAll('.rule-card'); c[c.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 50);
      toast('Rule added', 'info');
    });

    btnDeleteGroup.addEventListener('click', async () => {
      const g = getGroup(); if (!g) return;
      if (!await confirmAction(`Delete group "${esc(g.name)}" and all ${g.rules.length} rule(s)? This cannot be undone.`)) return;
      data.ruleGroups = data.ruleGroups.filter(x => x.id !== selectedGroupId);
      selectedGroupId = data.ruleGroups[0]?.id || null;
      draftSaveNow();
      render();
      toast('Group deleted', 'info');
    });

    geGroupName.addEventListener('input', () => { const g = getGroup(); if (g) { g.name = geGroupName.value; draftSave(); renderSidebar(); } });
    geGroupEnabled.addEventListener('change', () => { const g = getGroup(); if (g) { g.enabled = geGroupEnabled.checked; draftSaveNow(); renderSidebar(); } });

    btnExport.addEventListener('click', () => {
      const b = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(b);
      a.download = `request-wizard-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(a.href);
      toast('Exported');
    });

    btnImport.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const imp = JSON.parse(await f.text());
        if (!imp.ruleGroups) throw new Error('Invalid format');
        data = imp; if (data.globalEnabled === undefined) data.globalEnabled = true;
        if (data.debugLog === undefined) data.debugLog = false;
        selectedGroupId = data.ruleGroups[0]?.id || null;
        expandedRules.clear();
        await sendMsg('RW_PUBLISH_DATA', data);
        setDirty(false);
        render();
        toast('Imported & applied');
      } catch (err) { toast('Import failed: ' + err.message, 'error'); }
      fileInput.value = '';
    });
  }

  // ─── Helpers ───────────────────────────────────────────
  function getGroup() { return data.ruleGroups.find(g => g.id === selectedGroupId) || null; }
  function defaultRule() {
    return { id: gid(), name: 'New Rule', enabled: true,
      matching: { domainMatchType: 'regex', domainPattern: '.*', urlMatchType: 'regex', urlPattern: '.*', methods: [...METHODS] },
      modifications: { requestHeaders: [], responseHeaders: [], requestBody: { type: 'none', value: '' }, responseBody: { type: 'none', value: '' } }
    };
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ═══════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════
  function render() {
    globalToggle.checked = data.globalEnabled;
    globalLabel.textContent = data.globalEnabled ? 'Enabled' : 'Disabled';
    debugToggle.checked = !!data.debugLog;
    renderSidebar();
    renderMain();
  }

  function renderSidebar() {
    groupList.innerHTML = '';
    for (const g of data.ruleGroups) {
      const el = document.createElement('div');
      el.className = 'group-item' + (g.id === selectedGroupId ? ' active' : '');
      el.dataset.enabled = String(g.enabled);
      const n = g.rules.filter(r => r.enabled).length;
      el.innerHTML = `<span class="dot"></span><span class="gi-name">${esc(g.name)}</span><span class="gi-count">${n}/${g.rules.length}</span>`;
      el.onclick = () => { selectedGroupId = g.id; render(); };
      groupList.appendChild(el);
    }
  }

  function renderMain() {
    const g = getGroup();
    if (!g) { emptyState.style.display = 'flex'; groupEditor.style.display = 'none'; return; }
    emptyState.style.display = 'none'; groupEditor.style.display = 'block';
    geGroupName.value = g.name; geGroupEnabled.checked = g.enabled;
    renderGroupEditor();
  }

  function renderGroupEditor() {
    const g = getGroup(); if (!g) return;
    rulesList.innerHTML = '';
    if (g.rules.length === 0) {
      rulesList.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted);font-size:13px">No rules yet. Click "Add Rule" to create one.</div>';
      return;
    }
    for (const r of g.rules) rulesList.appendChild(buildCard(r, g));
  }

  // ═══════════════════════════════════════════════════════
  //  RULE CARD
  // ═══════════════════════════════════════════════════════
  function buildCard(rule, group) {
    const c = document.createElement('div');
    c.className = 'rule-card'; c.dataset.id = rule.id;
    if (expandedRules.has(rule.id)) c.classList.add('expanded');
    const m = rule.modifications;
    const b = (f, l, t) => `<span class="rule-badge ${f ? 'active' : ''}" title="${t}">${l}</span>`;

    c.innerHTML = `
      <div class="rule-header">
        <svg class="rule-chevron" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>
        <span class="rule-name-display" data-r="nd" title="Click to edit">${esc(rule.name)} ${PENCIL}</span>
        <input type="text" class="rule-name-input" value="${esc(rule.name)}" spellcheck="false" data-r="ni" style="display:none">
        <div class="rule-badges">${b(m.requestHeaders.length, 'ReqH', 'Request Headers: ' + m.requestHeaders.length)}${b(m.responseHeaders.length, 'ResH', 'Response Headers: ' + m.responseHeaders.length)}${b(m.requestBody.type !== 'none', 'ReqB', 'Request Body: ' + m.requestBody.type)}${b(m.responseBody.type !== 'none', 'ResB', 'Response Body: ' + m.responseBody.type)}</div>
        <label class="toggle-label rule-toggle" onclick="event.stopPropagation()">
          <input type="checkbox" ${rule.enabled ? 'checked' : ''} data-r="en">
          <span class="switch-track sm"><span class="switch-thumb"></span></span>
        </label>
        <button class="rule-delete" title="Delete Rule">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
        </button>
      </div>
      <div class="rule-body">
        ${buildMatching(rule)}
        ${buildHeaders('Request Headers', 'requestHeaders', rule)}
        ${buildBody('Request Body', 'requestBody', rule)}
        ${buildHeaders('Response Headers', 'responseHeaders', rule)}
        ${buildBody('Response Body', 'responseBody', rule)}
      </div>`;

    // --- Header click → expand/collapse (unless name / toggle / delete)
    c.querySelector('.rule-header').addEventListener('click', e => {
      if (e.target.closest('[data-r="ni"]') || e.target.closest('.rule-toggle') || e.target.closest('.rule-delete')) return;
      if (e.target.closest('[data-r="nd"]')) { e.stopPropagation(); enterEdit(c, rule); return; }
      c.classList.toggle('expanded');
      c.classList.contains('expanded') ? expandedRules.add(rule.id) : expandedRules.delete(rule.id);
    });

    // --- Name editing
    const ni = c.querySelector('[data-r="ni"]');
    ni.addEventListener('input', () => { rule.name = ni.value; draftSave(); });
    ni.addEventListener('blur', () => exitEdit(c, rule));
    ni.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); exitEdit(c, rule); }
      if (e.key === 'Escape') { ni.value = rule.name; exitEdit(c, rule); }
    });

    c.querySelector('[data-r="en"]').addEventListener('change', e => { rule.enabled = e.target.checked; draftSaveNow(); renderSidebar(); });

    c.querySelector('.rule-delete').addEventListener('click', async e => {
      e.stopPropagation();
      if (!await confirmAction(`Delete rule "${esc(rule.name)}"? This cannot be undone.`)) return;
      group.rules = group.rules.filter(r => r.id !== rule.id);
      expandedRules.delete(rule.id); draftSaveNow(); rerenderKeepScroll(); renderSidebar();
      toast('Rule deleted', 'info');
    });

    wireMatching(c, rule);
    wireHeaders(c, rule, 'requestHeaders');
    wireHeaders(c, rule, 'responseHeaders');
    wireBody(c, rule, 'requestBody');
    wireBody(c, rule, 'responseBody');
    wireCollapsibles(c);
    wireSnippetCopy(c);
    return c;
  }

  function enterEdit(c, r) { const d = c.querySelector('[data-r="nd"]'), i = c.querySelector('[data-r="ni"]'); d.style.display = 'none'; i.style.display = ''; i.focus(); i.select(); }
  function exitEdit(c, r) { const d = c.querySelector('[data-r="nd"]'), i = c.querySelector('[data-r="ni"]'); i.style.display = 'none'; d.style.display = ''; d.innerHTML = esc(r.name) + ' ' + PENCIL; }
  function wireCollapsibles(c) { c.querySelectorAll('.collapsible-toggle').forEach(t => t.addEventListener('click', e => { e.stopPropagation(); t.closest('.collapsible-block').classList.toggle('open'); })); }
  function wireSnippetCopy(c) {
    c.querySelectorAll('.snippet-copy-btn').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      const code = btn.closest('.snippet-item')?.querySelector('.snippet-code')?.textContent;
      if (!code) return;
      navigator.clipboard.writeText(code).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1500);
      });
    }));
  }

  // ═══════════════════════════════════════════════════════
  //  MATCHING
  // ═══════════════════════════════════════════════════════
  function collapsible(label, subtitle, code) {
    return `<div class="collapsible-block"><button class="collapsible-toggle"><svg class="collapsible-arrow" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg><span>${label}</span> — ${subtitle}</button><div class="collapsible-content"><pre class="example-code">${code}</pre></div></div>`;
  }

  function buildMatching(rule) {
    const m = rule.matching;
    const domEx = collapsible('Examples', '<code>value</code> = hostname',
      `<span class="c">// Exact</span>\nreturn value === 'api.example.com';\n\n<span class="c">// Subdomain wildcard</span>\nreturn value.endsWith('.example.com');\n\n<span class="c">// Whitelist</span>\nreturn ['a.com','b.com'].includes(value);\n\n<span class="c">// Exclude</span>\nreturn !value.includes('analytics');`);
    const urlEx = collapsible('Examples', '<code>value</code> = full URL',
      `<span class="c">// Path prefix</span>\nreturn new URL(value).pathname.startsWith('/api/v2/');\n\n<span class="c">// Query param</span>\nconst u = new URL(value);\nreturn u.searchParams.has('debug');\n\n<span class="c">// Extension</span>\nreturn /\\.(json|xml)$/.test(new URL(value).pathname);`);

    return `<div class="rule-section" data-section="matching">
      <div class="section-title"><svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/></svg> Matching</div>
      <div class="match-row"><div class="match-label">Domain</div><div class="match-input-group">
        <div class="match-type-select" data-match="domainMatchType">
          <button class="match-type-btn ${m.domainMatchType==='regex'?'active':''}" data-val="regex">Regex</button>
          <button class="match-type-btn ${m.domainMatchType==='function'?'active':''}" data-val="function">JS Function</button>
        </div>
        ${m.domainMatchType==='function'?`<textarea class="code-textarea" data-mf="domainPattern" placeholder="// return true to match">${esc(m.domainPattern)}</textarea>${domEx}`:`<input class="code-input" data-mf="domainPattern" value="${esc(m.domainPattern)}" placeholder=".*\\.example\\.com">`}
      </div></div>
      <div class="match-row"><div class="match-label">URL</div><div class="match-input-group">
        <div class="match-type-select" data-match="urlMatchType">
          <button class="match-type-btn ${m.urlMatchType==='regex'?'active':''}" data-val="regex">Regex</button>
          <button class="match-type-btn ${m.urlMatchType==='function'?'active':''}" data-val="function">JS Function</button>
        </div>
        ${m.urlMatchType==='function'?`<textarea class="code-textarea" data-mf="urlPattern" placeholder="// return true to match">${esc(m.urlPattern)}</textarea>${urlEx}`:`<input class="code-input" data-mf="urlPattern" value="${esc(m.urlPattern)}" placeholder="/api/.*">`}
      </div></div>
      <div class="match-row"><div class="match-label">Methods</div>
        <div class="methods-grid">${METHODS.map(x=>`<span class="method-chip ${m.methods.includes(x)?'selected':''}" data-method="${x}">${x}</span>`).join('')}</div>
      </div>
    </div>`;
  }

  function wireMatching(c, rule) {
    const s = c.querySelector('[data-section="matching"]'); if (!s) return;
    s.querySelectorAll('.match-type-select').forEach(sel => sel.querySelectorAll('.match-type-btn').forEach(btn => btn.addEventListener('click', () => { rule.matching[sel.dataset.match] = btn.dataset.val; draftSaveNow(); rerenderKeepScroll(rule.id); })));
    s.querySelectorAll('[data-mf]').forEach(el => el.addEventListener('input', () => { rule.matching[el.dataset.mf] = el.value; draftSave(); }));
    s.querySelectorAll('.method-chip').forEach(ch => ch.addEventListener('click', () => {
      const m = ch.dataset.method, i = rule.matching.methods.indexOf(m);
      i >= 0 ? rule.matching.methods.splice(i, 1) : rule.matching.methods.push(m);
      ch.classList.toggle('selected'); draftSave();
    }));
  }

  // ═══════════════════════════════════════════════════════
  //  HEADERS
  // ═══════════════════════════════════════════════════════
  function buildHeaders(title, field, rule) {
    const hdrs = rule.modifications[field];
    const ico = field === 'requestHeaders'
      ? '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"/></svg>'
      : '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.707 3.293a1 1 0 010 1.414L5.414 7H11a7 7 0 017 7v2a1 1 0 11-2 0v-2a5 5 0 00-5-5H5.414l2.293 2.293a1 1 0 11-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>';
    return `<div class="rule-section" data-section="${field}">
      <div class="section-title">${ico} ${title}</div>
      <div class="header-mods">${hdrs.map((h,i)=>`<div class="header-mod-row" data-idx="${i}">
        <select data-hf="action"><option value="set" ${h.action==='set'?'selected':''}>Set</option><option value="append" ${h.action==='append'?'selected':''}>Append</option><option value="remove" ${h.action==='remove'?'selected':''}>Remove</option></select>
        <input data-hf="name" value="${esc(h.name)}" placeholder="Header-Name">
        <input data-hf="value" value="${esc(h.value||'')}" placeholder="Value" ${h.action==='remove'?'disabled':''}>
        <button class="remove-btn" data-ri="${i}"><svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg></button>
      </div>`).join('')}</div>
      <button class="add-header-btn" data-ah="${field}" style="margin-top:8px"><svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/></svg> Add Header</button>
    </div>`;
  }

  function wireHeaders(c, rule, field) {
    const s = c.querySelector(`[data-section="${field}"]`); if (!s) return;
    s.querySelector(`[data-ah="${field}"]`).addEventListener('click', () => { rule.modifications[field].push({ action: 'set', name: '', value: '' }); draftSaveNow(); rerenderKeepScroll(rule.id); });
    s.querySelectorAll('.header-mod-row').forEach(row => {
      const i = +row.dataset.idx, h = rule.modifications[field][i]; if (!h) return;
      row.querySelectorAll('[data-hf]').forEach(el => {
        el.addEventListener('input', () => { h[el.dataset.hf] = el.value; draftSave(); });
        el.addEventListener('change', () => { h[el.dataset.hf] = el.value; if (el.dataset.hf === 'action') row.querySelector('[data-hf="value"]').disabled = el.value === 'remove'; draftSave(); });
      });
      row.querySelector('[data-ri]').addEventListener('click', () => { rule.modifications[field].splice(i, 1); draftSaveNow(); rerenderKeepScroll(rule.id); });
    });
  }

  // ═══════════════════════════════════════════════════════
  //  BODY
  // ═══════════════════════════════════════════════════════
  function buildBody(title, field, rule) {
    const mod = rule.modifications[field], isReq = field === 'requestBody';
    const ico = isReq
      ? '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clip-rule="evenodd"/></svg>'
      : '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V7.414A2 2 0 0015.414 6L12 2.586A2 2 0 0010.586 2H6zm5 6a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V8z" clip-rule="evenodd"/></svg>';

    const sig = isReq
      ? '<code>info</code> = { <code>url</code>, <code>method</code>, <code>headers</code> }'
      : '<code>info</code> = { <code>url</code>, <code>method</code>, <code>status</code>, <code>headers</code> }';

    const snippets = isReq
      ? [{ l:'Inject JSON field', c:'const obj = JSON.parse(body);\nobj._ts = Date.now();\nreturn JSON.stringify(obj);'},
         { l:'Auth via info.url', c:"const d = JSON.parse(body);\nif (info.url.includes('/admin/')) d.role = 'superadmin';\nreturn JSON.stringify(d);"},
         { l:'Form data', c:"const p = new URLSearchParams(body);\np.set('source','rw');\nreturn p.toString();"}]
      : [{ l:'Filter array', c:'const d = JSON.parse(body);\nd.items = d.items.filter(i=>i.active);\nreturn JSON.stringify(d);'},
         { l:'Debug metadata', c:"const d = JSON.parse(body);\nd.__debug = {status:info.status, url:info.url};\nreturn JSON.stringify(d,null,2);"},
         { l:'Mock on 500', c:"if(info.status>=500) return JSON.stringify({error:'mock',url:info.url});\nreturn body;"}];

    const snipBlock = `<div class="collapsible-block"><button class="collapsible-toggle"><svg class="collapsible-arrow" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg><span>Code Snippets</span> — click copy to paste</button>
    <div class="collapsible-content"><div class="snippets-list">${snippets.map(s=>`<div class="snippet-item"><div class="snippet-header"><span class="snippet-label">${s.l}</span><button class="snippet-copy-btn"><svg viewBox="0 0 20 20" fill="currentColor"><path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z"/><path d="M3 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v6h-4.586l1.293-1.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L10.414 13H15v3a2 2 0 01-2 2H5a2 2 0 01-2-2V5z"/></svg> Copy</button></div><pre class="snippet-code">${esc(s.c)}</pre></div>`).join('')}</div></div></div>`;

    const ph = isReq ? '// body, info = {url,method,headers}' : '// body, info = {url,method,status,headers}';

    return `<div class="rule-section" data-section="${field}">
      <div class="section-title">${ico} ${title}</div>
      <div class="body-mod">
        <div class="body-type-select" data-bt="${field}">
          <button class="body-type-btn ${mod.type==='none'?'active':''}" data-val="none">None</button>
          <button class="body-type-btn ${mod.type==='static'?'active':''}" data-val="static">Static</button>
          <button class="body-type-btn ${mod.type==='function'?'active':''}" data-val="function">JS Function</button>
        </div>
        ${mod.type==='static'?`
          <div class="body-hint"><strong>Static:</strong> Replace body entirely. Use JSON toolbar to format/minify.</div>
          <div class="json-toolbar" data-jt="${field}"><span class="toolbar-label">JSON</span>
            <button class="toolbar-btn" data-ja="format"><svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/></svg> Format</button>
            <button class="toolbar-btn" data-ja="minify"><svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/></svg> Minify</button>
            <button class="toolbar-btn" data-ja="validate"><svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Validate</button>
            <button class="toolbar-btn" data-ja="js2json"><svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z" clip-rule="evenodd"/></svg> JS→JSON</button>
          </div>
          <div class="json-status" data-js="${field}"></div>
          <textarea class="body-editor" data-bv="${field}" placeholder='{"key":"value"}'>${esc(mod.value)}</textarea>
        `:''}
        ${mod.type==='function'?`
          <div class="body-hint"><strong>Function:</strong> Receives <code>body</code> (string) + <code>info</code>. Return modified body.<br><span class="hint-signature">${sig}</span></div>
          ${snipBlock}
          <textarea class="body-editor body-editor-fn" data-bv="${field}" placeholder="${ph}">${esc(mod.value)}</textarea>
        `:''}
      </div>
    </div>`;
  }

  function wireBody(c, rule, field) {
    const s = c.querySelector(`[data-section="${field}"]`); if (!s) return;
    s.querySelectorAll(`[data-bt="${field}"] .body-type-btn`).forEach(b => b.addEventListener('click', () => { rule.modifications[field].type = b.dataset.val; draftSaveNow(); rerenderKeepScroll(rule.id); }));

    const tb = s.querySelector(`[data-jt="${field}"]`);
    if (tb) tb.querySelectorAll('[data-ja]').forEach(btn => btn.addEventListener('click', () => {
      const ed = s.querySelector(`[data-bv="${field}"]`), st = s.querySelector(`[data-js="${field}"]`);
      if (!ed) return; let v = ed.value.trim(); st.textContent = ''; st.className = 'json-status';
      const a = btn.dataset.ja;
      if (a === 'validate') { try { JSON.parse(v); st.textContent = '✓ Valid'; st.className = 'json-status json-status-ok'; } catch(e) { st.textContent = '✗ '+e.message; st.className = 'json-status json-status-err'; } return; }
      if (a === 'js2json') { try { JSON.parse(v); st.textContent = '✓ Already valid'; st.className = 'json-status json-status-ok'; return; } catch(e){} try { const o = new Function('return('+v.replace(/\/\/.*$/gm,'').replace(/\/\*[\s\S]*?\*\//g,'')+');')(); ed.value = JSON.stringify(o,null,2); rule.modifications[field].value = ed.value; draftSave(); st.textContent = '✓ Converted'; st.className = 'json-status json-status-ok'; } catch(e) { st.textContent = '✗ '+e.message; st.className = 'json-status json-status-err'; } return; }
      if (a === 'format') { try { ed.value = JSON.stringify(JSON.parse(v),null,2); rule.modifications[field].value = ed.value; draftSave(); st.textContent = '✓ Formatted'; st.className = 'json-status json-status-ok'; } catch(e) { st.textContent = '✗ '+e.message; st.className = 'json-status json-status-err'; } return; }
      if (a === 'minify') { try { ed.value = JSON.stringify(JSON.parse(v)); rule.modifications[field].value = ed.value; draftSave(); st.textContent = '✓ Minified'; st.className = 'json-status json-status-ok'; } catch(e) { st.textContent = '✗ '+e.message; st.className = 'json-status json-status-err'; } return; }
    }));

    const ed = s.querySelector(`[data-bv="${field}"]`);
    if (ed) {
      ed.addEventListener('input', () => { rule.modifications[field].value = ed.value; draftSave(); });
      ed.addEventListener('keydown', e => { if (e.key === 'Tab') { e.preventDefault(); const p = ed.selectionStart; ed.value = ed.value.substring(0,p)+'  '+ed.value.substring(ed.selectionEnd); ed.selectionStart = ed.selectionEnd = p+2; rule.modifications[field].value = ed.value; draftSave(); }});
    }
  }

  init();
})();
