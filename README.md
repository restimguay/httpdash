# HttpDash

A Postman-style API client for the desktop, built with Electron and plain JavaScript (no build step).

## Run it

```bash
npm install
npm start
```

Run the engine's unit tests (HTTP client, auth, scripts, runner, importers, code generation) with `npm test`.

Data is stored as JSON in Electron's `userData` folder (Settings → Data shows the path). Set `HTTPDASH_DATA_DIR` to use a different folder.

## Features

**Requests**
- Any HTTP method, URL bar with `{{variable}}` highlighting, hover tooltips and autocomplete
- Query params table synced with the URL, path variables (`/users/:id`), headers with bulk edit
- Bodies: raw (JSON / XML / HTML / JavaScript / text, with beautify and JSON linting), `form-data` with file uploads, `x-www-form-urlencoded`, binary file, GraphQL (query + variables)
- Auth: inherit from parent, Basic, Bearer, API key (header or query), Digest, OAuth 2.0 (client credentials and password grants, with a "Get New Access Token" button), AWS Signature v4
- Per-request settings: follow redirects, SSL verification, cookies, timeout
- Paste a cURL command into the URL bar to import it

**Responses**
- Status, time and size, with a breakdown of DNS / connect / TLS / first byte
- Pretty (JSON / XML / HTML formatting), Raw, Preview (sandboxed HTML, images) and Visualize (`pm.visualizer.set` with Handlebars-style templates)
- Search, line wrap, copy, save to file, save as example
- Headers, cookies, test results with filters, and a timeline showing the request actually sent and any redirects

**Scripts** (Postman-compatible `pm` API)
- Pre-request and test scripts on collections, folders and requests, run in Postman's order
- `pm.environment` / `globals` / `collectionVariables` / `variables` / `iterationData`, `pm.request` (headers, URL, query, body), `pm.response` (`json()`, `text()`, `headers`, `code`, `responseTime`)
- `pm.test`, `pm.expect` (Chai), `pm.response.to.have.status(...)` / `.header(...)` / `.jsonBody(...)` / `.jsonSchema(...)` / `.be.success` and similar
- `pm.sendRequest`, `pm.setNextRequest`, `pm.cookies`, `pm.visualizer`, `pm.execution.skipRequest`
- `CryptoJS` (MD5, SHA, HMAC, encoders), `atob` / `btoa`, `console.*` output in the Console panel, and legacy `tests[...]`, `postman.*`, `responseBody`
- Snippet library in the script editor

**Organisation**
- Collections and nested folders with drag-and-drop, rename, duplicate, delete and "Copy as cURL"
- Collection / folder settings: description, auth, scripts, collection variables
- Environments (with secret values), globals, environment quick look, dynamic variables (`{{$guid}}`, `{{$timestamp}}`, `{{$randomEmail}}`, …)
- History grouped by day, multiple tabs with unsaved-change tracking, all restored on restart

**Collection Runner**
- Run a collection or folder, choose which requests to include, environment, iterations and delay
- CSV / JSON data files (one iteration per row), `pm.setNextRequest` flow control, stop on failure
- Live results with per-request tests, request/response details and exportable JSON results
- Optionally persists variable changes made during the run

**Import / export & tools**
- Import Postman collections (v2.0 / v2.1), Postman environments and globals, OpenAPI 3 / Swagger 2 (JSON) and cURL; drag files onto the window to import
- Export collections (Postman v2.1), environments and globals in Postman format
- Code generation: cURL, raw HTTP, JavaScript fetch, Node.js Axios, Python requests, Go, PHP cURL, C# HttpClient, Java OkHttp, PowerShell, wget
- Cookie manager (view / add / edit / delete per domain)
- Settings: timeout, redirects, SSL verification, HTTP proxy (including HTTPS via CONNECT, with auth and bypass list), user agent, response size limit, light / dark / system theme, editor font size, stacked or side-by-side layout
- Console panel with network and script logs; keyboard shortcuts (Ctrl/Cmd+T, Enter, S, W, O)

## Not included

Compared with Postman, these are not implemented: WebSocket, gRPC, Socket.IO and MQTT requests; OAuth 2.0 authorization-code and implicit flows; NTLM, Hawk and Akamai auth; client certificates; mock servers, monitors, API documentation publishing, cloud sync and team workspaces; YAML OpenAPI import.

Scripts run in Node's `vm` module in the main process. That is not a security boundary, so only run collections whose scripts you trust (Postman has the same caveat).

## Layout

```
src/core/      request engine (no Electron dependency, unit-tested)
  http-client.js  HTTP/HTTPS with timings, redirects, decompression, proxy
  executor.js     variables, auth, bodies, scripts, cookies -> response
  sandbox.js      the pm.* script API
  runner.js       collection runner and CSV/JSON data files
  postman.js      Postman / OpenAPI import and export
  curl.js         cURL parser
  codegen.js      code snippet generators
src/main/      Electron main process, IPC, persistence, preload bridge
src/renderer/  UI (plain JS + CodeMirror 5)
test/          node:test unit tests against a local echo server
```
