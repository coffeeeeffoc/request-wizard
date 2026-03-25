/**
 * Request Wizard — Background Service Worker
 * Two-tier save: DRAFT (persist only) vs PUBLISH (persist + broadcast to tabs).
 */

const DEFAULT_DATA = {
  globalEnabled: true,
  debugLog: false,
  ruleGroups: [{
    id: gid(), name: 'Default Group', enabled: true, rules: []
  }]
};

function gid() {
  return 'rw_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ─── Storage ─────────────────────────────────────────────
async function loadData() {
  const r = await chrome.storage.local.get('requestWizardData');
  if (r.requestWizardData) return r.requestWizardData;
  await persistData(DEFAULT_DATA);
  return DEFAULT_DATA;
}

// Persist only — no broadcast
async function persistData(data) {
  await chrome.storage.local.set({ requestWizardData: data });
  updateBadge(data);
}

// Persist + broadcast to all tabs (= "publish / apply")
async function publishData(data) {
  await persistData(data);
  await broadcastRules(data);
}

async function broadcastRules(data) {
  try {
    const tabs = await chrome.tabs.query({});
    const payload = {
      globalEnabled: data.globalEnabled,
      debugLog: !!data.debugLog,
      rules: getActiveRules(data)
    };
    for (const tab of tabs) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'RW_RULES_UPDATED', payload }); }
      catch (e) { /* tab may not have content script */ }
    }
  } catch (e) { console.error('Broadcast error:', e); }
}

function getActiveRules(data) {
  if (!data.globalEnabled) return [];
  const rules = [];
  for (const g of data.ruleGroups) {
    if (!g.enabled) continue;
    for (const r of g.rules) { if (r.enabled) rules.push(r); }
  }
  return rules;
}

function updateBadge(data) {
  if (!data.globalEnabled) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#666' });
    return;
  }
  const c = getActiveRules(data).length;
  chrome.action.setBadgeText({ text: c > 0 ? String(c) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#6C5CE7' });
}

// ─── Message Handling ────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RW_GET_DATA') {
    loadData().then(d => sendResponse(d));
    return true;
  }
  // Draft save — persist to storage, do NOT broadcast to tabs
  if (msg.type === 'RW_DRAFT_DATA') {
    persistData(msg.payload).then(() => sendResponse({ success: true }));
    return true;
  }
  // Publish — persist AND broadcast (rules take effect)
  if (msg.type === 'RW_PUBLISH_DATA') {
    publishData(msg.payload).then(() => sendResponse({ success: true }));
    return true;
  }
  // Legacy compat — treat as publish
  if (msg.type === 'RW_SAVE_DATA') {
    publishData(msg.payload).then(() => sendResponse({ success: true }));
    return true;
  }
  if (msg.type === 'RW_GET_ACTIVE_RULES') {
    loadData().then(d => {
      sendResponse({ globalEnabled: d.globalEnabled, debugLog: !!d.debugLog, rules: getActiveRules(d) });
    });
    return true;
  }
  if (msg.type === 'RW_IMPORT_DATA') {
    const imp = msg.payload;
    if (imp && imp.ruleGroups) {
      publishData(imp).then(() => sendResponse({ success: true }));
    } else {
      sendResponse({ success: false, error: 'Invalid data format' });
    }
    return true;
  }
});

// ─── Tab Navigation → Push published rules ───────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    try {
      const d = await loadData();
      await chrome.tabs.sendMessage(tabId, {
        type: 'RW_RULES_UPDATED',
        payload: { globalEnabled: d.globalEnabled, debugLog: !!d.debugLog, rules: getActiveRules(d) }
      });
    } catch (e) { /* ignore */ }
  }
});

loadData().then(d => updateBadge(d));
