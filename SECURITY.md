# Security policy

HttpDash handles API credentials, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub instead: go to the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/restimguay/httpdash/security/advisories/new)).

Please include:
- what an attacker can do, and what they need first (for example, a collection they've shared with you);
- steps or a file that reproduce it;
- the HttpDash version and your operating system.

You can expect a first reply within 7 days. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Security fixes go into the latest release. Please check that the problem still happens on the latest version before reporting.

## How scripts are isolated

Pre-request and test scripts run in **QuickJS**, a separate JavaScript engine compiled to WebAssembly, with a fresh engine for every script. A script has no access to Node, `require` beyond a few built-in helpers, the file system, other processes, environment variables or HttpDash's own data. It only sees the `pm` API: the request, the response and the variables in scope. Each script is limited to 30 seconds, 256 MB of memory and a fixed stack depth.

**What a script can still do:** send HTTP requests with `pm.sendRequest`, and read and change the variables in scope. So a script from someone you don't trust could send your variables, including secrets, to a server of their choosing. Review scripts in collections you import or receive through team sync, as you would review code.

Ways out of the sandbox (reaching Node, files or processes, or getting past the limits) are in scope and especially welcome.

## In scope

- Credentials leaking into exports with **Leave out secrets** ticked, into team repositories, or into the audit log.
- Bypassing the app lock (LDAP sign-in) or reading workspace data while locked.
- A script reaching anything outside the sandbox: Node, files, processes, or HttpDash's own data beyond the variables in scope.
- Responses, imported files or mock-server requests that can run code or read files.
- Weaknesses in how tokens and passwords are stored with the OS keychain.
