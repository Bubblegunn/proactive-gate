# Redaction

Applied to every text file of this folder (final.md, trace.jsonl, code/, cost.json, grades/, tasks/, documents):

| what | placeholder |
|---|---|
| the home folder of the machine owner (and its resolved real path), and any path starting with /Users/ or /home/ followed by a name | `<HOME>` |
| e-mail addresses (except addresses at example.com, example.org, example.net, *.test, *.invalid, *.example, localhost, which are task fixtures) | `<EMAIL>` |
| strings starting with sk-ant- and other API key shapes (sk-..., ghp_..., github_pat_..., xox*-..., AKIA..., AIza..., JWT, PEM private keys) | `<KEY>` |
| any other 32+ character run of letters, digits, `_` and `-` that has upper case, lower case and a digit (hex hashes, UUIDs and tool ids are kept) | `<KEY>` |

Not redacted: the user name as a word outside a path (for example in `ls -l` output), process ids, time stamps.
Thinking blocks are not stored. Tool results in trace.jsonl are cut to 3000 characters (`"truncated": true`).

Replacements made: home paths 718, e-mail addresses 128, keys or tokens 4.
After writing, the builder re-read every file and failed if a home path, an e-mail or a key pattern remained.
