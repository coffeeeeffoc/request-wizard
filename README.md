# Request Wizard — Chrome Extension

Advanced HTTP request/response modifier with flexible rule groups.

## Features

- **Multi-group rule management** — Organize rules into named groups, toggle each independently
- **Request Header modification** — Set, Append, or Remove any request header
- **Response Header modification** — Set, Append, or Remove any response header
- **Request Body modification** — Replace with static content or transform via JS function
- **Response Body modification** — Replace with static content or transform via JS function
- **Domain matching** — Filter by hostname using Regex or custom JS function
- **URL matching** — Filter by full URL using Regex or custom JS function
- **Method filtering** — Apply rules only to specific HTTP methods
- **Persistent storage** — All configuration is saved to `chrome.storage.local` instantly; closing the page won't lose data
- **Import / Export** — Backup and share rule sets as JSON files
- **Global kill switch** — Instantly disable all interception with one toggle

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. The Request Wizard icon will appear in your toolbar

## How It Works

| Layer | Mechanism | What It Modifies |
|-------|-----------|-----------------|
| Content Script (MAIN world) | Overrides `window.fetch` and `XMLHttpRequest` | Request/response headers and bodies |
| Content Script (ISOLATED world) | Message bridge between background and page | Rule delivery |
| Background Service Worker | Storage, rule management, badge updates | Configuration persistence |

## Matching

### Regex Mode
The pattern is tested against the hostname (for domain) or full URL using JavaScript's `RegExp.test()`.

**Examples:**
- `.*` — matches everything
- `.*\.example\.com` — matches any subdomain of example.com
- `/api/v[12]/` — matches URLs containing /api/v1/ or /api/v2/

### JS Function Mode
Write a function body that receives `value` (the hostname or URL string) and returns `true`/`false`.

**Example (domain):**
```js
return value === 'api.example.com' || value.endsWith('.internal.io');
```

**Example (URL):**
```js
const url = new URL(value);
return url.pathname.startsWith('/api/') && url.searchParams.has('debug');
```

## Body Modification

### Static Mode
The original body is entirely replaced with the static text you provide.

### JS Function Mode
Write a function body that receives:
- `body` — the original body as a string
- `info` — an object with `{ url, method, headers }` (request) or `{ url, method, status, headers }` (response)

Return the modified body string.

**Example (inject a field into JSON request):**
```js
const obj = JSON.parse(body);
obj.timestamp = Date.now();
return JSON.stringify(obj);
```

**Example (transform JSON response):**
```js
const data = JSON.parse(body);
data.items = data.items.filter(item => item.active);
return JSON.stringify(data);
```

## Data Storage

All rules are persisted in `chrome.storage.local` under the key `requestWizardData`. Data is auto-saved with a 300ms debounce on every edit, plus an immediate save on toggle/delete actions. This means:

- Closing the options page mid-edit preserves your work
- Restarting Chrome preserves all rules
- You can export/import for backup or migration

## Permissions

| Permission | Purpose |
|-----------|---------|
| `storage` | Persist rule configuration |
| `activeTab` | Access the active tab for rule injection |
| `scripting` | Inject content scripts dynamically |
| `webRequest` | Monitor network requests |
| `tabs` | Broadcast rule updates to all tabs |
| `<all_urls>` | Apply rules to any website |

## License

MIT
