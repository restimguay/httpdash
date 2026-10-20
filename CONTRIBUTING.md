# Contributing to HttpDash

Thanks for helping. Bug reports, fixes, features, docs and Postman collections that HttpDash gets wrong are all welcome.

## Before you start

- **Bugs:** open an issue with the [bug report form](https://github.com/restimguay/httpdash/issues/new/choose). A Postman collection, cURL command or backup that reproduces it (with secrets removed) makes it much quicker to fix.
- **Features:** open a feature request first for anything bigger than a small change, so we can agree on the approach before you write code.
- **Security problems:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).
- **First contribution?** Look for issues labelled [`good first issue`](https://github.com/restimguay/httpdash/labels/good%20first%20issue).

## Set up

You need Node.js 22 or later and git.

```bash
git clone https://github.com/restimguay/httpdash.git
cd httpdash
npm install
npm start        # run the app
npm test         # run the unit tests
npm run cli -- run --help
```

There is no build step: the app is plain JavaScript, and changes show up on the next `npm start` (or **View → Reload** for renderer changes).

## Where things live

| Folder | What it holds |
| --- | --- |
| `src/core/` | The request engine: HTTP client, variables, auth, scripts, runner, importers, code generation, git sync. **No Electron imports**, so it runs under plain Node and in the CLI. |
| `src/main/` | Electron main process: windows, menus, IPC, storage. |
| `src/renderer/` | The UI, in plain JavaScript with CodeMirror 5. |
| `bin/` | The `httpdash` command-line runner. |
| `test/` | `node:test` unit tests, run against a local echo server in `test/helpers.js`. |
| `website/` | The httpdash.com site. |

Put logic in `src/core/` whenever you can, so it can be tested without Electron and works in the CLI too.

Scripts run inside a QuickJS sandbox. The `pm` API lives in `src/core/sandbox-guest.js`, which runs *inside* the sandbox and can only reach the outside through the host functions in `src/core/sandbox.js`. Keep those host functions small, and have them take and return plain strings and numbers. `src/core/vendor/chai.min.js` is generated: after upgrading chai, run `npm run vendor`.

## Making a change

1. Create a branch from `main`.
2. Make your change, matching the style of the code around it: plain CommonJS, small functions, comments only where the *why* isn't obvious.
3. Add or update tests in `test/` for anything in `src/core/`. Run `npm test`; it must pass.
4. For UI changes, try them in both light and dark themes and in a narrow window.
5. Update `README.md` if you changed how something works, and add a line under **Unreleased** in `CHANGELOG.md`.
6. Open a pull request and fill in the template. CI runs the tests and builds macOS, Windows and Linux packages.

Commit messages are short and in the imperative, like the existing history: `Add WebSocket requests`, `Fix URL bar text jumping on focus`.

## Postman compatibility

Running Postman collections unchanged is one of HttpDash's main promises. If a collection or script behaves differently than in Postman, that's a bug: please report it with the smallest collection that shows the difference.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
