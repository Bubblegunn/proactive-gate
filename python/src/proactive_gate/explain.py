"""explain(): a decision rendered as sentences a non-engineer can read.

The renderer is a pure function of the decision. Every fact in a sentence
comes from a trace entry's own reason or from a decision field, so it can
only describe a decision the gate actually made; a check that never ran has
no sentence. The machine reasons are the contract both implementations pin
word for word, which is what makes them safe to read back here. When a
reason does not match what a check emits, the sentence quotes it verbatim
rather than guessing.

``decision.reason`` is unchanged: the plain sentence and the machine reason
sit side by side and neither replaces the other.

Language is a parameter: English ships as ``EN``, and another language is a
mapping over the same keys, merged over English so a partial translation
still renders. The sentences match the TypeScript catalog word for word.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from .types import Decision, TraceEntry, iso_z

# A template reads the fields a parser pulled out of a machine reason.
SentenceTemplate = Callable[[Mapping[str, str]], str]
Sentences = dict[str, SentenceTemplate]
Facts = dict[str, str]


@dataclass(frozen=True, slots=True)
class CheckSentence:
    """One trace entry rendered: which check, what it said, and the sentence for it."""

    id: str
    outcome: str
    sentence: str
    shadow: bool = False


@dataclass(frozen=True, slots=True)
class Explanation:
    """``summary`` is the decision as one sentence; ``checks`` is one sentence per check that ran, in order."""

    summary: str
    checks: tuple[CheckSentence, ...]


# English ------------------------------------------------------------------


def _plural(n: int, unit: str) -> str:
    return f"{n} {unit}{'' if n == 1 else 's'}"


def _span_words(label: str) -> str:
    """'1d' to 'within the last day', '24h' to 'within the last 24 hours'."""
    m = re.fullmatch(r"(\d+)([dhms])", label)
    if not m:
        return f"within the last {label}"
    unit = {"d": "day", "h": "hour", "m": "minute", "s": "second"}[m.group(2)]
    n = int(m.group(1))
    return f"within the last {unit}" if n == 1 else f"within the last {_plural(n, unit)}"


def _seconds_words(text: str) -> str:
    """'86400' to 'day', '7200' to '2 hours': a rate-limit period in seconds, said long."""
    try:
        n = int(text)
    except ValueError:
        return f"{text} seconds"

    # "per hour", not "per 1 hour": the same singular _span_words already says as "the last day".
    def period(count: int, unit: str) -> str:
        return unit if count == 1 else _plural(count, unit)

    if n % 86400 == 0:
        return period(n // 86400, "day")
    if n % 3600 == 0:
        return period(n // 3600, "hour")
    if n % 60 == 0:
        return period(n // 60, "minute")
    return period(n, "second")


def _budget_pass(label: str) -> SentenceTemplate:
    # The spend note is true only when the pass really read the counter: a
    # bypassed budget returns a bare pass, a near-limit pass cannot be a bypass.
    def render(f: Mapping[str, str]) -> str:
        if "used" in f:
            return f"the {label} had room, but only just: {f['used']} of {f['limit']} already used; the unit is spent when the message actually goes out"
        return f"the {label} did not stop it"

    return render


def _budget_reject(label: str) -> SentenceTemplate:
    return lambda f: f"the {label} of {f['limit']} was already spent ({f['used']} used)"


def _held(f: Mapping[str, str]) -> str:
    until = f.get("until")
    return f"held{' until ' + until if until else ''} because {f['clause']}"


def _allowed(f: Mapping[str, str]) -> str:
    return f"allowed at {f['at']} because no check stopped it{f.get('notes', '')}"


def _quiet_reject(f: Mapping[str, str]) -> str:
    owned = f", a window belonging to {f['from']}," if "from" in f else ""
    return f"the user's quiet hours run {f['start']} to {f['end']} {f['tz']}{owned} and {f['priority']} priority is below the {f['floor']} floor needed to override them"


def _timing_adjust(f: Mapping[str, str]) -> str:
    surfaces = (f.get("surfaces") or "").replace(",", ", ")
    if "at" in f and "surfaces" in f:
        return f"delivery was moved to {f['at']} and narrowed to {surfaces}"
    if "at" in f:
        return f"delivery was moved to {f['at']}"
    return f"delivery was narrowed to {surfaces}"


def _window_pass(f: Mapping[str, str]) -> str:
    name = f.get("name")
    return f'the "{name}" allowed window did not block it' if name else "the allowed window did not block it"


def _consent_pass(f: Mapping[str, str]) -> str:
    name = f.get("name")
    if "start" in f:
        named = f'"{name}" ' if name else ""
        return f"the {named}consent is only needed between {f['start']} and {f['end']}, and it was outside those hours"
    return f'the "{name}" consent the check needs was in place' if name else "the consent the check needs was in place"


def _consent_reject(f: Mapping[str, str]) -> str:
    hours = f", which applies between {f['start']} and {f['end']}" if "start" in f else ""
    return f'the user has not given the required "{f["name"]}" consent{hours}'


def _recent_reject(f: Mapping[str, str]) -> str:
    if "age" in f:
        return f"the user's last message to the assistant was {f['age']} h ago, outside the {f['within']} h window"
    return "the user has never written to the assistant, and this rule allows messages only after they do"


def _fallback_pass(f: Mapping[str, str]) -> str:
    reason = f.get("reason")
    return f'the "{f["id"]}" check let it through{f" ({reason})" if reason else ""}'


EN: Sentences = {
    "summary.held": _held,
    "summary.allowed": _allowed,
    "summary.allowedEmpty": lambda f: "allowed; no checks ran",
    "summary.heldUnknown": lambda f: "held; the trace does not name the check that stopped it",
    "note.deliverAt": lambda f: f"delivery waits until {f['at']}",
    "note.nearLimit": lambda f: f"{f['check']} was close to its limit ({f['used']} of {f['limit']} used)",
    "note.shadowed": lambda f: f"{f['check']} would have stopped it but ran in shadow mode",
    "entry.shadow": lambda f: f"it would have stopped the message ({f['body']}), but the check ran in shadow mode so evaluation continued",
    "killSwitch.pass": lambda f: "the kill switch was off",
    "killSwitch.reject": lambda f: "the kill switch is on, which stops every message",
    "consent.pass": lambda f: "the user has agreed to proactive messages",
    "consent.reject": lambda f: "the user has not agreed to proactive messages",
    "enabled.pass": lambda f: "proactive messages are switched on for this profile",
    "enabled.reject": lambda f: "proactive messages are switched off on this user's profile",
    "mode.pass": lambda f: "the user's operating mode did not block it",
    "mode.reject": lambda f: f'the user\'s operating mode is "{f["mode"]}", which does not allow proactive messages',
    "snooze.pass": lambda f: "no snooze was in effect",
    "snooze.reject": lambda f: f"the user has snoozed the assistant until {f['until']}",
    "mute.pass": lambda f: "this type of message is not muted",
    "mute.reject": lambda f: f'the user has muted "{f["type"]}" messages',
    "intensity.pass": lambda f: "the message's priority satisfied the user's intensity setting",
    "intensity.reject": lambda f: f"the message was {f['priority']} priority, and the user's \"{f['level']}\" intensity setting allows only {f['floor']} and above",
    "quietHours.pass": lambda f: "quiet hours did not block it",
    "quietHours.reject": _quiet_reject,
    "quietHours.skip": lambda f: "the user has quiet hours but no time zone, so the check could not run",
    "trustRamp.pass": lambda f: "the new-user trust period did not block it",
    "trustRamp.reject": lambda f: f"the user is on day {f['day']} of a {f['days']}-day trust period for new users, which allows only {f['floor']} priority and above, and the message was {f['priority']}",
    "trustRamp.skip": lambda f: "the user's sign-up date is not on record, so the new-user trust period could not be checked",
    "dismissalCooldown.pass": lambda f: "the user has not dismissed this type enough to silence it",
    "dismissalCooldown.reject": lambda f: f"the user has dismissed \"{f['type']}\" messages {f['count']} times in {f['within']} days, so this type stays silent until {f['until']}",
    "adaptiveTiming.pass": lambda f: "the timing check left the message as it was",
    "adaptiveTiming.adjust": _timing_adjust,
    "dedupe.pass": lambda f: "this event had not already produced a message; the event is claimed when the message actually goes out",
    "dedupe.reject": lambda f: f"the same event already produced a message {_span_words(f.get('window', ''))}",
    "dedupe.skip": lambda f: "the candidate carried no event key, so duplicate detection could not run",
    "dailyBudget.pass": _budget_pass("daily budget"),
    "dailyBudget.reject": _budget_reject("user's daily budget"),
    "weeklyBudget.pass": _budget_pass("weekly budget"),
    "weeklyBudget.reject": _budget_reject("user's weekly budget"),
    "monthlyBudget.pass": _budget_pass("monthly budget"),
    "monthlyBudget.reject": _budget_reject("user's monthly budget"),
    "windowBudget.pass": _budget_pass("window budget"),
    "windowBudget.reject": lambda f: f"the budget for the window opened by the user's last message was already spent ({f['used']} of {f['limit']} used)",
    "rateLimit.pass": lambda f: "the rate limit did not stop it",
    "rateLimit.reject": lambda f: f"the rate limit of {f['limit']} messages per {_seconds_words(f.get('per', ''))} was already reached ({f['used']} used)",
    "budget.pass": lambda f: f"the budget had room, but only just: {f['used']} of {f['limit']} already used; the unit is spent when the message actually goes out",
    "budget.reject": lambda f: f"the {f['label']} was already used up ({f['used']} of {f['limit']} used)",
    "utilityFloor.pass": lambda f: "the estimated acceptance chance cleared the utility floor",
    "utilityFloor.reject": lambda f: f"the estimated chance the user would accept this message was {f['pAccept']}, below the utility floor of {f['tau']}",
    "utilityFloor.skip": lambda f: "the candidate carried no acceptance estimate, so the utility floor could not run",
    "boundedDeferral.pass": lambda f: "the user did not look busy",
    "boundedDeferral.adjust": lambda f: f"the user looked busy, so delivery was deferred {f['tStar']} seconds to {f['at']}",
    "allowedWindow.pass": _window_pass,
    "allowedWindow.reject": lambda f: f"messages may only go out between {f['start']} and {f['end']} ({f['zone']}), and the local time was outside that window",
    "allowedWindow.skip": lambda f: "the user has no time zone, so the allowed window could not be checked",
    "requiresConsent.pass": _consent_pass,
    "requiresConsent.reject": _consent_reject,
    "requiresConsent.skip": lambda f: "the user has no time zone, so the hours this consent applies could not be checked",
    "recentInteraction.pass": lambda f: "the user had written to the assistant recently enough",
    "recentInteraction.reject": _recent_reject,
    "gate.failOpen": lambda f: f"the \"{f['id']}\" check failed with \"{f['error']}\", and the gate is set to let messages through when a check fails",
    "gate.failClosed": lambda f: f"the \"{f['id']}\" check failed with \"{f['error']}\", and the gate is set to stop messages when a check fails",
    "gate.nonRejecting": lambda f: f"the \"{f['id']}\" check tried to {f['kind']} (\"{f['reason']}\") but is marked non-rejecting, so the gate ignored it",
    "fallback.stop": lambda f: f"the \"{f['id']}\" check stopped it: {f['reason']}",
    "fallback.pass": _fallback_pass,
    "fallback.skip": lambda f: f"the \"{f['id']}\" check did not weigh in: {f['reason']}",
    "fallback.adjust": lambda f: f"the \"{f['id']}\" check adjusted it: {f['reason']}",
}


# Reading the machine reasons back into facts ------------------------------ #

Parser = Callable[[str], "Facts | None"]


def _match(pattern: str, keys: tuple[str, ...]) -> Parser:
    compiled = re.compile(pattern)

    def parse(reason: str) -> Facts | None:
        m = compiled.fullmatch(reason)
        if not m:
            return None
        facts: Facts = {}
        for key, value in zip(keys, m.groups()):
            if value is not None:
                facts[key] = value
        return facts

    return parse


def _fixed(text: str) -> Parser:
    return lambda reason: {} if reason == text else None


def _first(*parsers: Parser) -> Parser:
    def parse(reason: str) -> Facts | None:
        for p in parsers:
            facts = p(reason)
            if facts is not None:
                return facts
        return None

    return parse


_BUDGET_STOP = _match(r".* of (\d+) used \((\d+)\)", ("limit", "used"))
_BUDGET_NEAR = _match(r"(\d+) of (\d+) used", ("used", "limit"))


def _parse_quiet_hours(reason: str) -> Facts | None:
    m = re.fullmatch(r"quiet hours (\S+) to (\S+)(?: \((\w+) (\S+)\))? (\S+); priority (\w+) is below the floor \((\w+)\)", reason)
    if not m:
        return None
    # holdUntil is the fact the summary headlines ("held until 08:00"); checks
    # whose clause already says the instant (snooze, cooldown) leave it unset.
    facts: Facts = {"start": m.group(1), "end": m.group(2), "tz": m.group(5), "priority": m.group(6), "floor": m.group(7), "holdUntil": m.group(2)}
    if m.group(3) is not None:
        facts["from"] = f"{m.group(3)} {m.group(4)}"
    return facts


def _consent_id_facts(check_id: str) -> Facts:
    return {"name": check_id[len("consent:"):]} if check_id.startswith("consent:") else {}


def _window_id_facts(check_id: str) -> Facts:
    return {"name": check_id[len("window:"):]} if check_id.startswith("window:") else {}


PARSERS: dict[str, dict[str, Parser | Callable[[str], Facts]]] = {
    "killSwitch": {"stop": _fixed("engine kill switch is on")},
    "consent": {"stop": _fixed("user has not consented to proactive behaviour")},
    "enabled": {"stop": _fixed("proactive behaviour is disabled on this profile")},
    "mode": {"stop": _match(r'operating mode "(.+)" does not allow proactive messages', ("mode",))},
    "snooze": {"stop": _match(r"snoozed until (.+)", ("until",))},
    "mute": {"stop": _match(r'type "(.+)" is muted by the user', ("type",))},
    "intensity": {"stop": _match(r'priority (\w+) is below the "(\w+)" intensity floor \((\w+)\)', ("priority", "level", "floor"))},
    "quietHours": {"stop": _parse_quiet_hours, "skip": _fixed("quiet hours set but no timezone on the user; cannot evaluate")},
    "trustRamp": {
        "stop": _match(r"trust ramp: day (\d+) of (\S+), priority (\w+) is below (\w+)", ("day", "days", "priority", "floor")),
        "skip": _fixed("no createdAt on the user; ramp cannot be evaluated"),
    },
    "dismissalCooldown": {"stop": _match(r'(\d+) dismissals of "(.+)" in (\S+) days; silent until (.+)', ("count", "type", "within", "until"))},
    "adaptiveTiming": {
        "adjust": _first(
            _match(r"deliver at (\S+); surfaces (.+)", ("at", "surfaces")),
            _match(r"deliver at (\S+)", ("at",)),
            _match(r"surfaces (.+)", ("surfaces",)),
        )
    },
    "dedupe": {"stop": _match(r"already delivered within the last (.+)", ("window",)), "skip": _fixed("no dedupeKey on the candidate; deduplication cannot be evaluated")},
    "dailyBudget": {"stop": _BUDGET_STOP, "passReason": _BUDGET_NEAR},
    "weeklyBudget": {"stop": _BUDGET_STOP, "passReason": _BUDGET_NEAR},
    "monthlyBudget": {"stop": _BUDGET_STOP, "passReason": _BUDGET_NEAR},
    "windowBudget": {"stop": _BUDGET_STOP, "passReason": _BUDGET_NEAR},
    "rateLimit": {"stop": _match(r"rate limit (\d+) per (\d+) s of \d+ used \((\d+)\)", ("limit", "per", "used")), "passReason": _BUDGET_NEAR},
    "utilityFloor": {"stop": _match(r"pAccept (\S+) < tau (\S+)", ("pAccept", "tau")), "skip": _fixed("no pAccept on the candidate; utility floor cannot be evaluated")},
    "boundedDeferral": {"adjust": _match(r"user busy; deliver at (\S+) \(t\* (\d+) s\)", ("at", "tStar"))},
    "allowedWindow": {
        "stop": _match(r"outside the allowed window (\S+) to (\S+) (.+)", ("start", "end", "zone")),
        "idFacts": _window_id_facts,
        "skip": _fixed("no timezone on the user; window cannot be evaluated"),
    },
    "requiresConsent": {
        "stop": _match(r'consent "(.+)" is missing(?: \(required (\S+) to (\S+)\))?', ("name", "start", "end")),
        "passReason": _match(r"outside the consent window (\S+) to (\S+)", ("start", "end")),
        "idFacts": _consent_id_facts,
        "skip": _fixed("no timezone on the user; consent window cannot be evaluated"),
    },
    "recentInteraction": {
        "stop": _first(
            _fixed("no inbound message from the user on record"),
            _match(r"last inbound message (\d+) h ago, window is (\S+) h", ("age", "within")),
        )
    },
}


def _key_for_id(check_id: str) -> str | None:
    """The ids the package itself emits: the fixed check ids, plus consent:<name>, rate:<limit>/<period>s and window:<name>."""
    if check_id in PARSERS:
        return check_id
    if check_id.startswith("consent:"):
        return "requiresConsent"
    if check_id.startswith("rate:"):
        return "rateLimit"
    if check_id.startswith("window:"):
        return "allowedWindow"
    return None


# The gate's own trace entries: a store failure, or a non-rejecting check that
# tried to stop evaluation anyway.
_GATE_ENTRIES: tuple[tuple[str, Parser], ...] = (
    ("gate.failOpen", _match(r"check threw \((.*)\); failing open", ("error",))),
    ("gate.failClosed", _match(r"check threw \((.*)\); failing closed", ("error",))),
    ("gate.nonRejecting", _match(r"non-rejecting check returned (\w+) \((.*)\); ignored", ("kind", "reason"))),
)

# Custom ids (a preset's "window:kakao", a caller's own wrapper) still emit the
# check's reason, so an unmatched id falls back to recognizing the reason's
# shape. Order is distinctiveness: each pattern names the check it sounds like.
_STOP_SCAN = ("quietHours", "allowedWindow", "requiresConsent", "rateLimit", "dismissalCooldown", "snooze", "mute", "mode", "intensity", "trustRamp", "dedupe", "utilityFloor", "recentInteraction", "killSwitch", "consent", "enabled")
_SKIP_SCAN = ("quietHours", "trustRamp", "dedupe", "utilityFloor", "allowedWindow", "requiresConsent")
_ADJUST_SCAN = ("adaptiveTiming", "boundedDeferral")

_BUDGET_LABELS = {"daily budget": "dailyBudget", "weekly budget": "weeklyBudget", "monthly budget": "monthlyBudget", "window budget": "windowBudget"}


def _scan_budget(reason: str) -> tuple[str, Facts] | None:
    """A 'label of N used (M)' reason from a budget whose id we do not know."""
    m = re.fullmatch(r"(.+) of (\d+) used \((\d+)\)", reason)
    if not m:
        return None
    key = _BUDGET_LABELS.get(m.group(1), "budget")
    return key, {"label": m.group(1), "limit": m.group(2), "used": m.group(3)}


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


def _sentence_of(fragment: str) -> str:
    return f"{_cap(fragment)}."


def _t(sentences: Mapping[str, SentenceTemplate], key: str, facts: Facts) -> str:
    template = sentences.get(key) or EN.get(key)
    return template(facts) if template else facts.get("reason", "")


def _stop_facts(entry: TraceEntry) -> tuple[str, Facts]:
    """The stopping entry's clause and, when the trace names it, the instant the hold lifts."""
    reason = entry.reason or ""
    for gkey, parse in _GATE_ENTRIES:
        gate_facts = parse(reason)
        if gate_facts is not None:
            return gkey, {"id": entry.id, **gate_facts}
    check_key = _key_for_id(entry.id)
    if check_key is not None:
        parser = PARSERS[check_key].get("stop")
        if parser is not None:
            own = parser(reason)
            if own is not None:
                return f"{check_key}.reject", own
    for k in _STOP_SCAN:
        parser = PARSERS[k].get("stop")
        if parser is None:
            continue
        scanned = parser(reason)
        if scanned is not None:
            return f"{k}.reject", scanned
    budget = _scan_budget(reason)
    if budget is not None:
        return f"{budget[0]}.reject", budget[1]
    return "fallback.stop", {"id": entry.id, "reason": reason}


def _entry_body(entry: TraceEntry, sentences: Mapping[str, SentenceTemplate]) -> str:
    reason = entry.reason or ""
    check_key = _key_for_id(entry.id)
    facts: Facts | None
    if entry.outcome in ("reject", "defer"):
        template, stop = _stop_facts(entry)
        return _t(sentences, template, stop)
    if entry.outcome == "pass":
        if reason:
            if check_key is not None:
                parser = PARSERS[check_key].get("passReason")
                facts = parser(reason) if parser is not None else None
            else:
                facts = _BUDGET_NEAR(reason)
            if facts is not None:
                # The id carries facts a reason does not, like which consent this is.
                from_id = PARSERS[check_key].get("idFacts") if check_key is not None else None
                named = dict(from_id(entry.id) or {}) if from_id is not None else {}
                return _t(sentences, f"{check_key or 'budget'}.pass", {**named, **facts})
            return _t(sentences, "fallback.pass", {"id": entry.id, "reason": reason})
        base: Facts = {}
        if check_key is not None:
            id_facts = PARSERS[check_key].get("idFacts")
            if id_facts is not None:
                base = dict(id_facts(entry.id) or {})
        return _t(sentences, f"{check_key}.pass" if check_key else "fallback.pass", {"id": entry.id, **base})
    if entry.outcome == "skip":
        for gkey, parse in _GATE_ENTRIES:
            facts = parse(reason)
            if facts is not None:
                return _t(sentences, gkey, {"id": entry.id, **facts})
        if check_key is not None:
            parser = PARSERS[check_key].get("skip")
            if parser is not None:
                facts = parser(reason)
                if facts is not None:
                    return _t(sentences, f"{check_key}.skip", facts)
        for k in _SKIP_SCAN:
            parser = PARSERS[k].get("skip")
            if parser is None:
                continue
            facts = parser(reason)
            if facts is not None:
                return _t(sentences, f"{k}.skip", facts)
        return _t(sentences, "fallback.skip", {"id": entry.id, "reason": reason})
    # adjust
    if check_key is not None:
        parser = PARSERS[check_key].get("adjust")
        if parser is not None:
            facts = parser(reason)
            if facts is not None:
                return _t(sentences, f"{check_key}.adjust", facts)
    for k in _ADJUST_SCAN:
        parser = PARSERS[k].get("adjust")
        if parser is None:
            continue
        facts = parser(reason)
        if facts is not None:
            return _t(sentences, f"{k}.adjust", facts)
    return _t(sentences, "fallback.adjust", {"id": entry.id, "reason": reason})


def _explain_entry(entry: TraceEntry, sentences: Mapping[str, SentenceTemplate]) -> CheckSentence:
    body = _entry_body(entry, sentences)
    # Shadow is only a would-have-stopped when the outcome could have stopped.
    if entry.shadow and entry.outcome in ("reject", "defer"):
        body = _t(sentences, "entry.shadow", {"body": body})
    return CheckSentence(id=entry.id, outcome=entry.outcome, sentence=_sentence_of(body), shadow=entry.shadow)


def _summarize(decision: Decision, sentences: Mapping[str, SentenceTemplate]) -> str:
    if decision.allowed:
        if not decision.trace:
            return _sentence_of(_t(sentences, "summary.allowedEmpty", {}))
        notes: list[str] = []
        if decision.deliver_at is not None:
            notes.append(_t(sentences, "note.deliverAt", {"at": iso_z(decision.deliver_at)}))
        for n in decision.near_limit:
            notes.append(_t(sentences, "note.nearLimit", {"check": n.check, "used": str(n.used), "limit": str(n.limit)}))
        for check_id in decision.shadowed:
            notes.append(_t(sentences, "note.shadowed", {"check": check_id}))
        return _sentence_of(_t(sentences, "summary.allowed", {"at": iso_z(decision.evaluated_at), "notes": "; " + "; ".join(notes) if notes else ""}))
    stop_id = decision.rejected_by or decision.deferred_by
    entry = next((e for e in reversed(decision.trace) if e.id == stop_id and e.outcome in ("reject", "defer")), None) if stop_id else None
    if entry is None:
        return _sentence_of(_t(sentences, "summary.heldUnknown", {}))
    template, facts = _stop_facts(entry)
    clause = _t(sentences, template, facts)
    # For a deferral the hold ends at retryAt; when the clause already names the
    # instant (snooze's reason is "snoozed until X"), naming it twice reads worse.
    clause_says_when = "until" in facts
    until = facts.get("holdUntil")
    if until is None and not clause_says_when and decision.deferred_by and decision.retry_at is not None:
        until = iso_z(decision.retry_at)
    held_facts: Facts = {"clause": clause}
    if until is not None:
        held_facts["until"] = until
    return _sentence_of(_t(sentences, "summary.held", held_facts))


def explain(decision: Decision, language: str = "en", catalogs: Mapping[str, Mapping[str, SentenceTemplate]] | None = None) -> Explanation:
    """Render a decision as sentences. Deterministic: the same decision always
    produces the same explanation, and nothing outside the decision is read."""
    overlay = (catalogs or {}).get(language)
    if language != "en" and overlay is None:
        raise ValueError(f'no sentence catalog for language "{language}"; pass one with the catalogs argument')
    sentences: Sentences = {**EN, **(overlay or {})}
    return Explanation(summary=_summarize(decision, sentences), checks=tuple(_explain_entry(e, sentences) for e in decision.trace))


__all__ = ["EN", "CheckSentence", "Explanation", "SentenceTemplate", "Sentences", "explain"]
