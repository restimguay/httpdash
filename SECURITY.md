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

## Known limitation: scripts are not sandboxed

Pre-request and test scripts run in Node's `vm` module in the main process. That is **not a security boundary**: a script can reach the rest of your computer. Only run collections whose scripts you trust, including collections that arrive through team sync. Postman has the same caveat.

Moving scripts into a real sandbox is planned. Until then, reports that only show that a script can escape `vm` are already known, but ways that scripts run *without* the user choosing to send a request or run a collection are in scope.

## In scope

- Credentials leaking into exports with **Leave out secrets** ticked, into team repositories, or into the audit log.
- Bypassing the app lock (LDAP sign-in) or reading workspace data while locked.
- Responses, imported files or mock-server requests that can run code or read files.
- Weaknesses in how tokens and passwords are stored with the OS keychain.
