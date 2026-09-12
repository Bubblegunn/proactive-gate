/**
 * The playground's two lists of rendered rows: the trace table and the scenario buttons.
 *
 * Both are built as DOM nodes and every piece of text is written with `textContent`. That is
 * the point of this file existing at all. A trace reason is assembled by the library from
 * values that reach it from the editable Input JSON on the page: `quietHours` builds its
 * reason from `user.timezone` and the window strings, so a string a visitor types into that
 * textarea ends up inside a reason. Joining those reasons into a string of HTML puts caller
 * text into an HTML sink, and the page is about to carry more caller-supplied data, not less.
 *
 * No exploit was run against the previous version and none is claimed here. It was an unsafe
 * render path; this is the safe one.
 *
 * It is a plain .mjs file under public/ rather than a bundled module for one reason: the
 * browser loads exactly this file, and so does test/playground-render.test.mjs. There is no
 * build step in between that could make the tested code and the shipped code differ.
 *
 * The DOM is passed in rather than reached for through a global, so the test can drive these
 * functions with a small stand-in document and no browser.
 */

/** The glyph vocabulary the CLI and docs/assets/trace.svg use, so all three read as one tool. */
export const GLYPH = { pass: "✓", reject: "✗", defer: "→", skip: "·" };

/**
 * The classes for one trace row. Only the check that actually stopped the message is filled;
 * a shadow row is dimmed. Kept pure and exported so the styling rule is testable on its own.
 */
export function rowClasses(entry, stoppedBy) {
  return [entry.id === stoppedBy ? "stop" : `o-${entry.outcome}`, entry.shadow ? "shadow" : ""]
    .filter(Boolean)
    .join(" ");
}

const cell = (doc, tag, className, text) => {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = String(text);
  return el;
};

/**
 * Replaces the contents of `tbody` with one row per trace entry.
 *
 * `trace` is the decision's trace, `stoppedBy` the id of the check that rejected or deferred.
 */
export function renderTraceTable(tbody, trace, stoppedBy, doc) {
  const rows = trace.map((entry, index) => {
    const tr = doc.createElement("tr");
    tr.className = rowClasses(entry, stoppedBy);

    tr.appendChild(cell(doc, "td", "n", index + 1));

    const idCell = cell(doc, "td", "");
    idCell.appendChild(cell(doc, "code", "", entry.id));
    tr.appendChild(idCell);

    const outcome = cell(doc, "td", "oc");
    outcome.appendChild(cell(doc, "span", "g", GLYPH[entry.outcome] ?? GLYPH.skip));
    // A leading space so the glyph and the word do not run together, written as text.
    outcome.appendChild(cell(doc, "span", "", ` ${entry.outcome}`));
    if (entry.shadow) {
      outcome.appendChild(cell(doc, "span", "", " "));
      outcome.appendChild(cell(doc, "span", "sh", "shadow"));
    }
    tr.appendChild(outcome);

    tr.appendChild(cell(doc, "td", "rs", entry.reason ?? ""));
    tr.appendChild(cell(doc, "td", "ms", entry.ms));
    return tr;
  });
  tbody.replaceChildren(...rows);
  return rows;
}

/**
 * Replaces the contents of `container` with one button per scenario.
 *
 * These labels are page constants rather than caller input, so this was never the reachable
 * path. It is built the same way anyway: a second rendering style on the same page is how the
 * unsafe one comes back, and the scope note below is about to carry more prose.
 */
export function renderScenarioButtons(container, scenarios, doc) {
  const buttons = scenarios.map((scenario) => {
    const button = doc.createElement("button");
    button.className = "scen-b";
    button.setAttribute("type", "button");
    button.setAttribute("data-key", scenario.key);
    button.appendChild(cell(doc, "span", "scen-l", scenario.label));
    button.appendChild(cell(doc, "span", "scen-n", scenario.note));
    return button;
  });
  container.replaceChildren(...buttons);
  return buttons;
}
