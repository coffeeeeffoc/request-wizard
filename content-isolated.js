/**
 * Request Wizard — Content Script (ISOLATED world)
 * Bridges background ↔ MAIN-world interceptor.
 */
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
