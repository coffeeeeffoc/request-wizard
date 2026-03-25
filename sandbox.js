/**
 * Request Wizard — Sandbox (eval environment)
 * Runs inside a manifest-declared sandbox page where dynamic code execution
 * is permitted regardless of the host page's CSP.
 *
 * Communication: receives postMessage from content-isolated.js,
 * returns results via postMessage back to parent.
 */
(function () {
  'use strict';

  // eslint-disable-next-line no-new-func -- intentional: sandbox exists specifically for dynamic eval
  const makeFn = (args, body) => new Function(...args, body);

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.id || msg.type !== 'RW_EVAL') return;

    const { id, evalType, pattern, args } = msg;
    try {
      let result;
      if (evalType === 'match') {
        result = !!makeFn(['value'], pattern)(args.value);
      } else if (evalType === 'body') {
        result = makeFn(['body', 'info'], pattern)(args.body, args.info);
      } else {
        e.source.postMessage({ type: 'RW_EVAL_RESULT', id, result: null, error: 'Unknown evalType: ' + evalType }, '*');
        return;
      }
      e.source.postMessage({ type: 'RW_EVAL_RESULT', id, result }, '*');
    } catch (err) {
      e.source.postMessage({ type: 'RW_EVAL_RESULT', id, result: null, error: err.message }, '*');
    }
  });
})();
