# Security

Report a vulnerability privately through GitHub's security advisories:
https://github.com/Bubblegunn/proactive-gate/security/advisories/new

Do not open a public issue for a security problem. You will get a first response within
72 hours, and a fix or a written assessment within 14 days of confirmation.

## Supported versions

Only the latest minor release receives security fixes. Upgrade before reporting if you are
behind; if the problem reproduces on the latest release, report it.

## Scope

The library runs inside your process and talks to the store you give it. In scope: anything that lets a candidate bypass a check, corrupt a counter, or leak store contents through the decision trace.
