# HttpDash

A Postman-style API client for the desktop, built with Electron and plain JavaScript (no build step).

![Request with spoofed Referer, Origin and User-Agent headers](docs/screenshots/01-referrer-spoofing.png)

## Run it

```bash
npm install
npm start
```

Run the engine's unit tests (HTTP client, auth, scripts, runner, importers, code generation) with `npm test`.

Data is stored as JSON in Electron's `userData` folder (Settings → Data shows the path). Set `HTTPDASH_DATA_DIR` to use a different folder.

## Download / build for macOS and Windows

Every push and pull request runs the GitHub Actions workflow in `.github/workflows/build.yml`, which tests the app and then builds:

| Platform | Files |
| --- | --- |
| macOS (Intel and Apple Silicon) | `HttpDash-<version>-mac-x64.dmg`, `…-mac-arm64.dmg`, plus `.zip` versions |
| Windows (x64 and ARM64) | `HttpDash-Setup-<version>-x64.exe` / `-arm64.exe` installers, and a no-install `HttpDash-<version>-portable.exe` |

Download them from the workflow run's **Artifacts**. Pushing a tag such as `v1.0.0` also attaches them to a GitHub Release.

To build locally, run `npm run dist:mac` on a Mac or `npm run dist:win` on Windows. Output goes to `dist/`.

**Code signing.** Without certificates, the Mac build is ad-hoc signed and the Windows build is unsigned:
- **macOS:** the first launch is blocked by Gatekeeper. Right-click the app and choose **Open**, or run `xattr -cr /Applications/HttpDash.app`.
- **Windows:** SmartScreen may warn. Choose **More info → Run anyway**.

To sign (and notarize on Mac), add these repository secrets; the workflow picks them up automatically:
- macOS: `MAC_CSC_LINK` (base64 .p12), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`

## Import and export everything

**Export** (top bar) offers two formats:
- **HttpDash backup:** one `.json` file with everything: collections, environments, globals, history, service discovery sources, settings and cookies.
- **Postman format:** a folder with one `.postman_collection.json` per collection, one `.postman_environment.json` per environment, and a globals file, ready for Postman or teammates. Auth dependencies and discovery sources are HttpDash-only, so they are not in these files.

Tick **Leave out secrets** before sharing an export. This empties secret variables and the variables holding auth-dependency tokens, removes credentials typed into auth fields (references like `{{token}}` are kept), and drops discovery tokens, the proxy password and cookies. Without it, the file contains your credentials.

**Import** accepts all of these, and several files can be selected at once (for example a whole Postman export folder). For a backup, you choose:
- **Merge:** adds everything; items that already exist are added as copies marked "(imported)", and existing global keys are kept.
- **Replace:** swaps your current workspace for the backup. It asks for confirmation first.

![Export all](docs/screenshots/17-export-all.png)

## Auth dependencies (auto-refresh tokens)

A collection, folder or request can name another request, such as **Login**, to run first when the token it needs is missing or expired. Set it up in the **Authorization** tab under **Auth dependency**:

1. Set the collection's auth to **Bearer Token** with `{{token}}`.
2. Choose **Run a request first** and pick the login request.
3. Fill in where the token sits in the login response, for example `access_token` or `data.access_token`, and optionally the `expires_in` path.

On every send, HttpDash checks `{{token}}`:
- **Empty or expired:** it runs the login request first, saves the new token (and its expiry) in the environment, then sends your request.
- **Still valid:** it sends your request straight away.

Expiry comes from the expiry variable, which is computed from `expires_in`. If there's no expiry variable, it uses a JWT token's `exp` claim. The token is refreshed 30 seconds early by default.

More details:
- **Retry on 401:** optionally, if the server still answers 401, it refreshes the token and retries once.
- **Inheritance:** requests and folders inherit the setting, or can override it or turn it off.
- **No loops:** the login request never depends on itself.
- **Collection Runner:** it logs in once and reuses the token, even if the login request is unticked in the run.
- **Visibility:** the response shows a banner when a dependency ran, and the Timeline shows its details.

Auth dependencies are saved in HttpDash's workspace. Postman's export format has no field for them, so they are not included when you export to Postman.

![Auth dependency settings](docs/screenshots/10-auth-dependency-setup.png)

## Service discovery (auto-create environments)

Point HttpDash at a service registry and it builds an environment with one variable per service. For example, `{{orders_url}}` = `http://10.0.1.5:8080`, so requests can use `{{orders_url}}/api/orders`.

To add a registry, open **Environments** in the sidebar and click **Service discovery → +**.

| Registry | What it reads |
| --- | --- |
| Consul | `/v1/catalog/services` plus each service's healthy instances. Options: ACL token, datacenter, tag filter, http/https. |
| Eureka (Spring Cloud) | `/eureka/apps`, instances with status UP only. Uses each app's home page URL or its host and port. |
| Kubernetes | Services in a namespace (or `*` for all), using a service-account bearer token and an optional label selector. The address can be the cluster DNS name, the cluster IP, or the external LoadBalancer address. |
| Custom JSON | Any endpoint returning a list of services or a `{ "name": "url" }` map. You set the list path, the name field, and a URL field or template such as `http://{host}:{port}`. |

- **Preview services** shows what would be created, without changing anything.
- **Create environment** makes the environment the first time.
- **Sync / Re-sync** updates the same environment in place: changed URLs are updated, new services are added, and services that vanished are removed (unless you tick "keep"). Variables you added yourself, such as API keys, are never touched.
- **Variable names** follow a pattern: `{name}_url` by default, or `{NAME}_BASE` for upper case.
- **Startup sync:** each source can be set to sync automatically when HttpDash starts.
- **Settings:** registry requests use your proxy settings, and SSL verification can be turned off per source (useful for Kubernetes API servers with self-signed certificates).

![Service discovery preview](docs/screenshots/14-discovery-preview.png)

## Spoofing Referer, Origin, User-Agent and other headers

Requests are sent from Node's HTTP stack, not a browser, so none of the browser's "forbidden header" rules apply. Whatever you put in the **Headers** tab is sent exactly as written, including:
- `Referer`, `Origin` and `User-Agent`
- `Host` (useful for virtual hosts)
- `Cookie` (overrides the cookie jar for that request)
- `X-Forwarded-For` and other `Sec-*` headers

The header-name field autocompletes common headers. A custom `Referer` is kept when redirects are followed.

Some of these are set automatically if you don't set them (User-Agent, Accept, Accept-Encoding, Cache-Control, Host, Content-Type, Content-Length). Your own value always wins; **Show auto-generated** in the Headers tab lists them. The default User-Agent can be changed in Settings.

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
- Import HttpDash backups, Postman collections (v2.0 / v2.1), environments and globals, OpenAPI 3 / Swagger 2 (JSON) and cURL; drag files onto the window to import
- Export everything as a restorable backup or as Postman files, or export single collections, environments and globals
- Code generation: cURL, raw HTTP, JavaScript fetch, Node.js Axios, Python requests, Go, PHP cURL, C# HttpClient, Java OkHttp, PowerShell, wget
- Cookie manager (view / add / edit / delete per domain)
- Settings: timeout, redirects, SSL verification, HTTP proxy (including HTTPS via CONNECT, with auth and bypass list), user agent, response size limit, light / dark / system theme, editor font size, stacked or side-by-side layout
- Console panel with network and script logs; keyboard shortcuts (Ctrl/Cmd+T, Enter, S, W, O)

## Screenshots

| | |
| --- | --- |
| ![Tests](docs/screenshots/02-tests.png) Test scripts and results | ![Timeline](docs/screenshots/03-timeline.png) Timeline of the exact request sent |
| ![JSON body](docs/screenshots/04-json-body.png) JSON body with dynamic variables | ![OAuth 2.0](docs/screenshots/05-oauth2.png) OAuth 2.0 token helper |
| ![Code snippet](docs/screenshots/06-code-snippet.png) Code generation | ![Runner](docs/screenshots/07-runner.png) Collection runner with a data file |
| ![Environment](docs/screenshots/08-dark-environment.png) Environments (dark theme) | ![Console](docs/screenshots/09-dark-console.png) Console |

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
