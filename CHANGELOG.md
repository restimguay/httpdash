# Changelog

Notable changes to HttpDash. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- Scripts now run in a real sandbox: QuickJS, a separate JavaScript engine compiled to WebAssembly, with a fresh engine per script and limits on time (30 s), memory (256 MB) and stack depth. Scripts can no longer reach Node, files or other processes, which matters most for collections that arrive through team sync. Previously they ran in Node's `vm` module, which a script could escape.

### Added
- Scripts can use `Buffer`, `TextEncoder` / `TextDecoder`, `URL.canParse`, SHA-224 and SHA-384, `CryptoJS.enc.Base64url`, and `require('buffer')`.
- `console.log` supports format strings such as `%s` and `%d`, like Node.

## [1.0.0] - 2026-10-21

First release.

### Added
- Requests with any method, params, headers, every body type (raw, form-data with files, URL-encoded, binary, GraphQL) and cURL paste.
- Auth: Basic, Bearer, API key, Digest, OAuth 2.0 (client credentials and password grants) and AWS Signature v4, inherited through collections and folders.
- **Auth dependencies:** a login request runs first when the token is missing or expired, with optional retry on 401.
- Postman-compatible scripts (`pm.*` API, Chai, `pm.sendRequest`, `pm.setNextRequest`, CryptoJS, visualizer).
- Collection Runner with CSV and JSON data files.
- **Service discovery:** environments built and synced from Consul, Eureka, Kubernetes or a custom JSON registry.
- Import from Postman (v2.0/v2.1), OpenAPI 3, Swagger 2 and cURL; export everything as an HttpDash backup or as Postman files, with **Leave out secrets**.
- Code generation for 11 languages and tools.
- **Team sharing** through any git repository, with readable per-request files and conflict choices.
- Command-line runner (`httpdash run`) with CLI, JSON and JUnit reporters.
- Monitors, mock servers, secret scan and a local audit log.
- App lock with LDAP sign-in and a recovery code.
- macOS (Intel and Apple Silicon), Windows (x64 and ARM64) and Linux (AppImage and `.deb`, x64 and ARM64) builds.
- **Help** menu with **Check for Updates…**, release notes, documentation and issue links. The update check only runs when you choose it, so HttpDash makes no network calls of its own.
- `httpdash --version` in the command-line runner.
- MIT license, contributing guide, security policy, code of conduct, and issue and pull request templates.

[Unreleased]: https://github.com/restimguay/httpdash/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/restimguay/httpdash/releases/tag/v1.0.0
