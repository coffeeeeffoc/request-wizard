/**
 * Request Wizard — Interceptor (MAIN world)
 * Overrides fetch() and XMLHttpRequest to apply body/header modifications.
 *
 * When the host page's CSP blocks dynamic code execution (unsafe-eval),
 * function-type matching and body modification are delegated to a sandbox
 * iframe via postMessage relay through the ISOLATED-world content script.
 *
 * Debug log points (search for [RW:xx] to set breakpoints):
 *   [RW:01] Rules received from background
 *   [RW:02] fetch() intercepted — matching started
 *   [RW:03] Rule matched for fetch
 *   [RW:04] Request headers modified (fetch)
 *   [RW:05] Request body modified (fetch)
 *   [RW:06] fetch() sent with modifications
 *   [RW:07] Response headers modified (fetch)
 *   [RW:08] Response body modified (fetch)
 *   [RW:09] fetch() response returned (modified)
 *   [RW:10] XHR.open() intercepted
 *   [RW:11] XHR.send() intercepted — matching started
 *   [RW:12] Rule matched for XHR
 *   [RW:13] XHR request headers modified
 *   [RW:14] XHR request body modified
 *   [RW:15] XHR response body modified
 *   [RW:16] No rules matched — passthrough
 *   [RW:17] Match error (regex/function)
 *   [RW:18] Body modification error
 *   [RW:19] CSP detected — sandbox eval enabled
 */
(function () {
  'use strict';

  if (window.__RW_INTERCEPTOR_INSTALLED__) return;
  window.__RW_INTERCEPTOR_INSTALLED__ = true;

  let activeRules = [];
  let globalEnabled = false;
  let debugLog = false;

  // ─── CSP detection ───────────────────────────────────────
  // Try to create a trivial Function. If this throws, the page's CSP blocks
  // unsafe-eval and we must delegate function-type eval to the sandbox iframe.
  let _cspBlocked = false;
  try { (0, Function)(''); } catch (e) { _cspBlocked = true; } // eslint-disable-line no-new-func

  // ─── Debug logger ──────────────────────────────────────
  function log(code, msg, data) {
    if (!debugLog) return;
    const tag = '%c[Request Wizard]%c ' + code + ' ' + msg;
    if (data !== undefined) {
      console.log(tag, 'color:#6C5CE7;font-weight:bold', 'color:inherit', data);
    } else {
      console.log(tag, 'color:#6C5CE7;font-weight:bold', 'color:inherit');
    }
  }

  // ─── Sandbox eval (async, CSP-safe) ─────────────────────
  let _evalIdCounter = 0;
  const _evalCallbacks = new Map();

  // Listen for results coming back from sandbox via ISOLATED world
  window.addEventListener('__RW_EVAL_RESULT__', (e) => {
    try {
      const msg = JSON.parse(e.detail);
      if (msg.type === 'RW_EVAL_RESULT' && _evalCallbacks.has(msg.id)) {
        _evalCallbacks.get(msg.id)(msg);
        _evalCallbacks.delete(msg.id);
      }
    } catch (err) { /* ignore */ }
  });

  function evalInSandbox(evalType, pattern, args) {
    return new Promise((resolve) => {
      const id = '__rw_eval_' + (++_evalIdCounter);
      const timeout = setTimeout(() => {
        _evalCallbacks.delete(id);
        resolve({ result: null, error: 'Sandbox eval timeout' });
      }, 5000);
      _evalCallbacks.set(id, (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      });
      window.dispatchEvent(new CustomEvent('__RW_EVAL__', {
        detail: JSON.stringify({ type: 'RW_EVAL', id, evalType, pattern, args })
      }));
    });
  }

  // ─── Receive rules ─────────────────────────────────────
  window.addEventListener('__RW_RULES__', (e) => {
    try {
      const data = JSON.parse(e.detail);
      globalEnabled = data.globalEnabled;
      debugLog = !!data.debugLog;
      activeRules = data.rules || [];
      log('[RW:01]', `Rules received: ${activeRules.length} active, global=${globalEnabled}, debug=${debugLog}`); // [RW:01]
      if (_cspBlocked) log('[RW:19]', 'CSP blocks unsafe-eval on this page — function rules use sandbox'); // [RW:19]
    } catch (err) { /* ignore */ }
  });

  // ─── Matching ──────────────────────────────────────────
  function testMatchSync(type, pattern, value) {
    if (!pattern || pattern === '.*' || pattern === '') return true;
    try {
      if (type === 'regex') return new RegExp(pattern).test(value);
      if (type === 'function') return !!(new Function('value', pattern))(value); // eslint-disable-line no-new-func
    } catch (e) {
      log('[RW:17]', `Match error: type=${type}, pattern=${pattern}`, e); // [RW:17]
    }
    return false;
  }

  async function testMatchAsync(type, pattern, value) {
    if (!pattern || pattern === '.*' || pattern === '') return true;
    if (type === 'regex') {
      try { return new RegExp(pattern).test(value); } catch (e) {
        log('[RW:17]', `Match error: type=${type}, pattern=${pattern}`, e);
        return false;
      }
    }
    if (type === 'function') {
      const res = await evalInSandbox('match', pattern, { value });
      if (res.error) log('[RW:17]', `Sandbox match error: pattern=${pattern}`, res.error);
      return !!res.result;
    }
    return false;
  }

  function getMatchingRulesSync(url, method) {
    if (!globalEnabled) return [];
    let hostname = '';
    try { hostname = location.hostname; } catch (e) { return []; }

    return activeRules.filter(rule => {
      const m = rule.matching;
      if (m.methods && m.methods.length > 0 && !m.methods.includes(method.toUpperCase())) return false;
      if (!testMatchSync(m.domainMatchType, m.domainPattern, hostname)) return false;
      if (!testMatchSync(m.urlMatchType, m.urlPattern, url)) return false;
      return true;
    });
  }

  async function getMatchingRulesAsync(url, method) {
    if (!globalEnabled) return [];
    let hostname = '';
    try { hostname = location.hostname; } catch (e) { return []; }

    const results = [];
    for (const rule of activeRules) {
      const m = rule.matching;
      if (m.methods && m.methods.length > 0 && !m.methods.includes(method.toUpperCase())) continue;
      if (!(await testMatchAsync(m.domainMatchType, m.domainPattern, hostname))) continue;
      if (!(await testMatchAsync(m.urlMatchType, m.urlPattern, url))) continue;
      results.push(rule);
    }
    return results;
  }

  function getMatchingRules(url, method) {
    if (_cspBlocked && hasFunctionRules()) return getMatchingRulesAsync(url, method);
    return getMatchingRulesSync(url, method);
  }

  function hasFunctionRules() {
    return activeRules.some(r => {
      const m = r.matching;
      return m.domainMatchType === 'function' || m.urlMatchType === 'function';
    });
  }

  function hasFunctionBodyRules() {
    return activeRules.some(r => {
      const mods = r.modifications;
      return (mods.requestBody?.type === 'function') || (mods.responseBody?.type === 'function');
    });
  }

  // ─── Modification helpers ──────────────────────────────
  function applyHeaderMods(headers, mods) {
    const h = new Headers(headers || {});
    for (const mod of mods) {
      if (!mod.name) continue;
      switch (mod.action) {
        case 'set':    h.set(mod.name, mod.value || ''); break;
        case 'append': h.append(mod.name, mod.value || ''); break;
        case 'remove': h.delete(mod.name); break;
      }
    }
    return h;
  }

  function applyBodyModSync(mod, originalBody, info) {
    if (!mod || mod.type === 'none') return originalBody;
    try {
      if (mod.type === 'static') return mod.value;
      if (mod.type === 'function') return (new Function('body', 'info', mod.value))(originalBody, info); // eslint-disable-line no-new-func
    } catch (e) {
      log('[RW:18]', `Body modification error: type=${mod.type}`, e); // [RW:18]
    }
    return originalBody;
  }

  async function applyBodyModAsync(mod, originalBody, info) {
    if (!mod || mod.type === 'none') return originalBody;
    if (mod.type === 'static') return mod.value;
    if (mod.type === 'function') {
      const res = await evalInSandbox('body', mod.value, { body: originalBody, info });
      if (res.error) {
        log('[RW:18]', `Sandbox body modification error`, res.error); // [RW:18]
        return originalBody;
      }
      return res.result;
    }
    return originalBody;
  }

  function applyBodyMod(mod, originalBody, info) {
    if (_cspBlocked && mod && mod.type === 'function') return applyBodyModAsync(mod, originalBody, info);
    return applyBodyModSync(mod, originalBody, info);
  }

  function headersToPlain(headers) {
    const obj = {};
    if (headers && typeof headers.forEach === 'function') headers.forEach((v, k) => { obj[k] = v; });
    else if (headers && typeof headers === 'object') Object.assign(obj, headers);
    return obj;
  }

  // ═══════════════════════════════════════════════════════
  //  FETCH OVERRIDE
  // ═══════════════════════════════════════════════════════
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    let [input, init] = args;
    init = init || {};
    const rawUrl = typeof input === 'string' ? input
      : (input instanceof URL ? input.href
        : (input instanceof Request ? input.url : String(input)));
    const url = new URL(rawUrl, window.location.href).href;
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    log('[RW:02]', `fetch() intercepted: ${method} ${url}`); // [RW:02]

    // getMatchingRules returns sync array or Promise — always await for uniform handling
    const matchedRules = await getMatchingRules(url, method);

    if (matchedRules.length === 0) {
      log('[RW:16]', `No rules matched for fetch ${method} ${url}`); // [RW:16]
      return originalFetch.apply(this, args);
    }

    matchedRules.forEach(r => log('[RW:03]', `Rule matched: "${r.name}" (${r.id})`, r)); // [RW:03]

    let reqHeaders = new Headers(init.headers || (input instanceof Request ? input.headers : {}));
    let reqBody = init.body !== undefined ? init.body : (input instanceof Request ? await input.text().catch(() => null) : null);
    const requestInfo = { url, method, headers: headersToPlain(reqHeaders) };

    // Apply request modifications
    for (const rule of matchedRules) {
      const mods = rule.modifications;
      if (mods.requestHeaders && mods.requestHeaders.length > 0) {
        reqHeaders = applyHeaderMods(reqHeaders, mods.requestHeaders);
        log('[RW:04]', `Request headers modified by "${rule.name}"`, { mods: mods.requestHeaders, result: headersToPlain(reqHeaders) }); // [RW:04]
      }
      if (mods.requestBody && mods.requestBody.type !== 'none') {
        const bodyStr = typeof reqBody === 'string' ? reqBody : (reqBody ? await new Response(reqBody).text().catch(() => '') : '');
        const before = bodyStr;
        reqBody = await applyBodyMod(mods.requestBody, bodyStr, requestInfo);
        log('[RW:05]', `Request body modified by "${rule.name}"`, { before: before?.substring(0, 200), after: typeof reqBody === 'string' ? reqBody.substring(0, 200) : reqBody }); // [RW:05]
      }
    }

    const modInit = { ...init, headers: reqHeaders, method };
    if (reqBody !== null && reqBody !== undefined && method !== 'GET' && method !== 'HEAD') modInit.body = reqBody;

    log('[RW:06]', `fetch() sending modified request: ${method} ${url}`, { headers: headersToPlain(reqHeaders) }); // [RW:06]

    let response;
    if (input instanceof Request) response = await originalFetch.call(this, new Request(url, modInit));
    else response = await originalFetch.call(this, url, modInit);

    const hasResponseMod = matchedRules.some(r =>
      (r.modifications.responseHeaders?.length > 0) || (r.modifications.responseBody?.type !== 'none')
    );
    if (!hasResponseMod) return response;

    let respHeaders = new Headers(response.headers);
    let respBody = await response.text();
    const responseInfo = { url, method, status: response.status, headers: headersToPlain(respHeaders) };

    for (const rule of matchedRules) {
      const mods = rule.modifications;
      if (mods.responseHeaders && mods.responseHeaders.length > 0) {
        respHeaders = applyHeaderMods(respHeaders, mods.responseHeaders);
        log('[RW:07]', `Response headers modified by "${rule.name}"`, { mods: mods.responseHeaders, result: headersToPlain(respHeaders) }); // [RW:07]
      }
      if (mods.responseBody && mods.responseBody.type !== 'none') {
        const before = respBody?.substring(0, 200);
        respBody = await applyBodyMod(mods.responseBody, respBody, responseInfo);
        log('[RW:08]', `Response body modified by "${rule.name}"`, { before, after: typeof respBody === 'string' ? respBody.substring(0, 200) : respBody }); // [RW:08]
      }
    }

    log('[RW:09]', `fetch() returning modified response: status=${response.status}`, { headers: headersToPlain(respHeaders), bodyPreview: typeof respBody === 'string' ? respBody.substring(0, 100) : null }); // [RW:09]

    return new Response(respBody, {
      status: response.status, statusText: response.statusText, headers: respHeaders
    });
  };

  // ═══════════════════════════════════════════════════════
  //  XHR OVERRIDE
  // ═══════════════════════════════════════════════════════
  const XHRProto = window.XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;
  const origSetRequestHeader = XHRProto.setRequestHeader;

  XHRProto.open = function (method, url) {
    this.__rw_method = (method || 'GET').toUpperCase();
    this.__rw_url = new URL(url, window.location.href).href;
    this.__rw_headers = {};
    log('[RW:10]', `XHR.open(): ${this.__rw_method} ${url}`); // [RW:10]
    return origOpen.apply(this, arguments);
  };

  XHRProto.setRequestHeader = function (name, value) {
    this.__rw_headers = this.__rw_headers || {};
    this.__rw_headers[name] = value;
    return origSetRequestHeader.apply(this, arguments);
  };

  // Shared XHR send logic — works both sync and async
  function xhrSendCore(self, body, matchedRules) {
    const url = self.__rw_url;
    const method = self.__rw_method || 'GET';

    matchedRules.forEach(r => log('[RW:12]', `Rule matched for XHR: "${r.name}" (${r.id})`)); // [RW:12]

    const requestInfo = { url, method, headers: { ...(self.__rw_headers || {}) } };

    for (const rule of matchedRules) {
      const mods = rule.modifications;
      if (mods.requestHeaders?.length > 0) {
        for (const mod of mods.requestHeaders) {
          if (!mod.name) continue;
          if (mod.action === 'set' || mod.action === 'append') origSetRequestHeader.call(self, mod.name, mod.value || '');
        }
        log('[RW:13]', `XHR request headers modified by "${rule.name}"`, mods.requestHeaders); // [RW:13]
      }
    }

    let modBody = body;
    // Note: in async (CSP) path, body mods are handled before calling this function
    if (!_cspBlocked) {
      for (const rule of matchedRules) {
        const mods = rule.modifications;
        if (mods.requestBody?.type !== 'none') {
          const bodyStr = typeof modBody === 'string' ? modBody : (modBody ? String(modBody) : '');
          modBody = applyBodyModSync(mods.requestBody, bodyStr, requestInfo);
          log('[RW:14]', `XHR request body modified by "${rule.name}"`, { before: bodyStr?.substring(0, 200), after: typeof modBody === 'string' ? modBody.substring(0, 200) : modBody }); // [RW:14]
        }
      }
    }

    const hasResponseMod = matchedRules.some(r =>
      (r.modifications.responseHeaders?.length > 0) || (r.modifications.responseBody?.type !== 'none')
    );

    if (hasResponseMod) {
      self.addEventListener('readystatechange', function () {
        if (self.readyState === 4) {
          let respBody = self.responseText;
          const responseInfo = { url, method, status: self.status, headers: {} };
          try {
            self.getAllResponseHeaders().split('\r\n').forEach(line => {
              const idx = line.indexOf(':');
              if (idx > 0) responseInfo.headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            });
          } catch (e) {}

          // Response body mods — for CSP pages use sync attempt (already in readystatechange,
          // can't go async here). If the page has CSP, response function-body mods will use
          // the sandbox via a deferred approach: override .responseText getter with a promise-
          // resolved value. However, since readystatechange is inherently sync, we use a
          // microtask workaround for CSP pages.
          if (_cspBlocked && matchedRules.some(r => r.modifications.responseBody?.type === 'function')) {
            // For CSP-blocked pages, apply response body mods asynchronously
            // then update the overridden properties
            (async () => {
              for (const rule of matchedRules) {
                if (rule.modifications.responseBody?.type !== 'none') {
                  const before = respBody?.substring(0, 200);
                  respBody = await applyBodyMod(rule.modifications.responseBody, respBody, responseInfo);
                  log('[RW:15]', `XHR response body modified by "${rule.name}"`, { status: self.status, before, after: typeof respBody === 'string' ? respBody.substring(0, 200) : respBody }); // [RW:15]
                }
              }
              Object.defineProperty(self, 'responseText', { get: () => respBody, configurable: true });
              Object.defineProperty(self, 'response', { get: () => respBody, configurable: true });
            })();
          } else {
            for (const rule of matchedRules) {
              if (rule.modifications.responseBody?.type !== 'none') {
                const before = respBody?.substring(0, 200);
                respBody = applyBodyModSync(rule.modifications.responseBody, respBody, responseInfo);
                log('[RW:15]', `XHR response body modified by "${rule.name}"`, { status: self.status, before, after: typeof respBody === 'string' ? respBody.substring(0, 200) : respBody }); // [RW:15]
              }
            }
            Object.defineProperty(self, 'responseText', { get: () => respBody, configurable: true });
            Object.defineProperty(self, 'response', { get: () => respBody, configurable: true });
          }
        }
      });
    }

    return modBody;
  }

  XHRProto.send = function (body) {
    const url = this.__rw_url;
    const method = this.__rw_method || 'GET';
    const self = this;

    log('[RW:11]', `XHR.send(): ${method} ${url}`); // [RW:11]

    const needsAsync = _cspBlocked && (hasFunctionRules() || hasFunctionBodyRules());

    if (needsAsync) {
      // Async path: get matching rules via sandbox, then send
      getMatchingRulesAsync(url, method).then(async (matchedRules) => {
        if (matchedRules.length === 0) {
          log('[RW:16]', `No rules matched for XHR ${method} ${url}`); // [RW:16]
          origSend.call(self, body);
          return;
        }

        // Apply async body mods before sending
        let modBody = body;
        const requestInfo = { url, method, headers: { ...(self.__rw_headers || {}) } };
        for (const rule of matchedRules) {
          const mods = rule.modifications;
          if (mods.requestBody?.type !== 'none') {
            const bodyStr = typeof modBody === 'string' ? modBody : (modBody ? String(modBody) : '');
            modBody = await applyBodyMod(mods.requestBody, bodyStr, requestInfo);
            log('[RW:14]', `XHR request body modified by "${rule.name}"`, { before: bodyStr?.substring(0, 200), after: typeof modBody === 'string' ? modBody.substring(0, 200) : modBody }); // [RW:14]
          }
        }

        const finalBody = xhrSendCore(self, modBody, matchedRules);
        origSend.call(self, finalBody);
      });
      // Don't call origSend synchronously — it will be called in the .then()
      return;
    }

    // Sync path: no CSP issues
    const matchedRules = getMatchingRulesSync(url, method);
    if (matchedRules.length === 0) {
      log('[RW:16]', `No rules matched for XHR ${method} ${url}`); // [RW:16]
      return origSend.apply(this, arguments);
    }

    const modBody = xhrSendCore(this, body, matchedRules);
    return origSend.call(this, modBody);
  };

})();
