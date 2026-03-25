/**
 * Request Wizard — Content Script (ISOLATED world)
 * Bridges background ↔ MAIN-world interceptor.
 * Also creates a sandbox iframe and relays eval requests when the page's CSP
 * blocks dynamic code execution.
 */

// ─── Rules bridge (existing) ──────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'RW_RULES_UPDATED') {
    window.dispatchEvent(new CustomEvent('__RW_RULES__', {
      detail: JSON.stringify(msg.payload)
    }));
  }
});

chrome.runtime.sendMessage({ type: 'RW_GET_ACTIVE_RULES' }, (response) => {
  if (response) {
    window.dispatchEvent(new CustomEvent('__RW_RULES__', {
      detail: JSON.stringify(response)
    }));
  }
});

// ─── Sandbox eval bridge ──────────────────────────────────
// Created lazily: only when MAIN world detects CSP blocks dynamic code.
let sandboxFrame = null;
let sandboxReady = false;
const pendingToSandbox = [];

function ensureSandbox() {
  if (sandboxFrame) return;
  sandboxFrame = document.createElement('iframe');
  sandboxFrame.src = chrome.runtime.getURL('sandbox.html');
  sandboxFrame.style.cssText = 'display:none!important;width:0;height:0;border:0;position:fixed;top:-9999px';
  (document.documentElement || document.body).appendChild(sandboxFrame);

  sandboxFrame.addEventListener('load', () => {
    // Verify the iframe actually loaded (not blocked/empty)
    if (!sandboxFrame.contentWindow) {
      console.error('[Request Wizard] Sandbox iframe failed to load — sandbox.html may not be web-accessible.');
      return;
    }
    sandboxReady = true;
    for (const msg of pendingToSandbox) {
      sandboxFrame.contentWindow.postMessage(msg, '*');
    }
    pendingToSandbox.length = 0;
  });

  sandboxFrame.addEventListener('error', () => {
    console.error('[Request Wizard] Sandbox iframe load error — function-type rules will not work on this page.');
  });
}

function sendToSandbox(msg) {
  if (sandboxReady && sandboxFrame) {
    sandboxFrame.contentWindow.postMessage(msg, '*');
  } else {
    pendingToSandbox.push(msg);
  }
}

// MAIN world → ISOLATED (CustomEvent) → sandbox iframe (postMessage)
window.addEventListener('__RW_EVAL__', (e) => {
  try {
    const msg = JSON.parse(e.detail);
    ensureSandbox();
    sendToSandbox(msg);
  } catch (err) { /* ignore malformed */ }
});

// sandbox iframe → ISOLATED (postMessage) → MAIN world (CustomEvent)
window.addEventListener('message', (e) => {
  if (!sandboxFrame || e.source !== sandboxFrame.contentWindow) return;
  const msg = e.data;
  if (!msg || msg.type !== 'RW_EVAL_RESULT') return;
  window.dispatchEvent(new CustomEvent('__RW_EVAL_RESULT__', {
    detail: JSON.stringify(msg)
  }));
});
