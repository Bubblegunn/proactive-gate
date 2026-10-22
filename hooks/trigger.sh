#!/bin/sh
# UserPromptSubmit hook for proactive-gate. Reads the hook JSON on stdin. When the prompt is about an
# agent or job that sends messages under limits, it prints one line of context; otherwise it prints
# nothing. POSIX sh only: no network, no file writes, no JSON parser, no language runtime.
LC_ALL=C
export LC_ALL
set -u

# Read the hook JSON with builtins only (it is one line in practice).
input=''
while IFS= read -r line || [ -n "$line" ]; do
  input="$input$line"
done

sending='(message|messages|messaging|notification|notify|reminder|remind|nudge|alert|sms|text users|texting|push|email|emails|digest|newsletter|whatsapp|telegram|slack bot)'
rules='(quiet hours|night|nighttime|at night|limit|cap|per day|daily|weekly|rate limit|throttle|consent|opt-out|opt out|unsubscribe|stop keyword|tcpa|legal|window|snooze|do not disturb|mute|frequency|too many|spam|fatigue|replay|last week)'

# One sed run does the whole check. It takes the value of the "prompt" key (lines without that key are
# dropped), turns each backslash escape into a space, lower-cases, pads both ends with a space so every
# word has a non-letter on each side, keeps the line only if it has a sending word AND a rule word, and
# then prints the context line in place of the prompt.
script='
s/.*"prompt"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/
t hit
d
:hit
s/\\./ /g
y/ABCDEFGHIJKLMNOPQRSTUVWXYZ/abcdefghijklmnopqrstuvwxyz/
s/^/ /
s/$/ /
/[^[:alpha:]]'"$sending"'(s|es)?[^[:alpha:]]/!d
/[^[:alpha:]]'"$rules"'(s|es)?[^[:alpha:]]/!d
s/.*/This request is about an agent or job sending messages with limits, quiet hours, consent or legal windows: use the proactive-gate skill (Skill tool, name proactive-gate) and its library instead of hand-written rules./
'
printf '%s' "$input" | sed -E "$script"
exit 0
