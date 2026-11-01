// assert-bundle-fresh.controls — each guard's deletion must fail a row, and the control must prove what it did.
//
// Why a file: these controls were shell snippets with `set -u` and not `set -e`, so a patch that silently
// failed to apply ran the *unpatched* gate, which passed, and the control reported success. That defect was
// live here for three rounds.
//
// Each control is checked on FOUR axes, because each of the first three can be satisfied by an accident:
//
//   1. INVENTORY  the anchor existed AND the bytes changed — a no-op patch certifies a guard it never touched.
//   2. SET        the failing rows equal the declared set — "at least one row went red" is satisfied by a
//                 single unrelated failure.
//   3. CAUSE      each row failed for the declared component (code / match / derived). The peer's measurement:
//                 its `ctl-asserted` declaration said `code`, but row 13 failed on its MESSAGE — the gate still
//                 exited 1, because the artefact had only stopped being *asserted*. A true set with a false
//                 cause is a false claim about your own control, and no set-based check can see it.
//   4. REASON     the failure text matches the guard that owns it.
//
// `meta-wrong-cause` is a permanent self-test of axis 3: a patch that changes bytes, produces exactly the
// declared set, and touches no property — distinguishable from a real control only by its causes. If the cause
// check is deleted, that row stops being rejected and this file goes red.
//
// Patched copies are written to a scratch dir and handed to the selftest via GATE_UNDER_TEST, so the real gate
// is never mutated; its digest is checked before and after anyway.
//
//   node scripts/assert-bundle-fresh.controls.mjs
//
// Exit 0 = every control owned exactly its declared rows and causes. Exit 1 = at least one did not.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The deletion audit runs a COPY of this file from a scratch directory, so the paths it audits are passed in
// explicitly rather than derived from the copy's own location. Without this the copy resolves its own directory,
// finds no gate there, exits 1 with no summary — and the audit reads that as "the deletion turned the suite red",
// which is the crash-as-red defect one level up from the one the audit exists to catch.
const here = process.env.BUNDLE_FRESH_HERE
  ? resolve(process.env.BUNDLE_FRESH_HERE)
  : resolve(dirname(new URL(import.meta.url).pathname));
// `BUNDLE_FRESH_GATE` lets the deletion audit point every mutated copy at a COPY of the gate, so a mutant that
// deletes the repair below corrupts a temp file rather than the instrument. Containment is the audit's job; the
// controls only need to say where the gate is.
const gatePath = process.env.BUNDLE_FRESH_GATE
  ? resolve(process.env.BUNDLE_FRESH_GATE)
  : join(here, "assert-bundle-fresh.mjs");
const selftest = join(here, "assert-bundle-fresh.selftest.mjs");

const read = (p) => readFileSync(p, "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

const original = read(gatePath);
const before = sha(original);

const scratch = mkdtempSync(join(tmpdir(), "bundle-fresh-controls-"));
// The mutation targets a per-run COPY, never the gate. The previous version appended to the gate itself and
// repaired it two lines later — a window in which any abort, OOM kill or thrown exception left the instrument
// corrupted by the harness that grades it. The peer measured exactly that window (exit 3, real gate
// 16386 -> 16466 bytes). Containment is now structural: the gate is never written, so there is nothing to
// repair and no window in which to fail to.
const gateCheck = join(scratch, "gate-check.mjs");
const MUTATION_LINE = "\n// mutated by meta-gate-mutation\n";
writeFileSync(gateCheck, original);
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

/** Occurrences on lines that are not comments. A comment that documents a guard must not satisfy a grep for
 * that guard: measured here, the separator read 2 — one site, one comment explaining it — on a file where the
 * exit-two token already read 1 for exactly that reason. Comments are excluded, and the check is on the count. */
function occurrencesOutsideComments(source, needle) {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .filter((line) => line.includes(needle)).length;
}

/** Which component of the row flipped. Derived from the selftest's own reason text, not from the patch. */
function causeOf(why) {
  const text = why.trim();
  if (/^exit \d+, expected \d+$/.test(text)) return "code";
  if (/but no \//.test(text)) return "match";
  return "derived";
}

function patched(oldText, newText) {
  if (!original.includes(oldText)) {
    throw new Error(`control patch has no anchor — the guard text moved: ${oldText.slice(0, 70)}`);
  }
  const patchedText = original.replace(oldText, newText);
  if (patchedText === original) throw new Error(`control patch changed nothing: ${oldText.slice(0, 70)}`);
  return patchedText;
}

const EXIT2_ROWS = [
  "wrong root, no manifest",
  "other repo, no scripts.bundle",
  "invalid JSON manifest",
  "no esbuild binary",
  "two --outfile flags",
  "--outdir, no single outfile",
  "non-esbuild step names a bundle",
  "no rebuildable step at all",
  "declared name resolves outside root",
  "stale artefact AND a declared name outside root",
];

const controls = [
  {
    // The owner of the gate-integrity check. Without it that check is unreachable — nothing else writes to the
    // gate — and by the rule this file enforces, an unreachable check is decoration: the peer deleted its
    // `expectGreen` branch for exactly this reason and gave the check an owner instead.
    //
    // It runs FIRST so every later control grades a repaired file. That ordering is what makes the repair
    // load-bearing rather than incidental: move this row to the end and nothing is left for it to protect.
    name: "meta-gate-mutation",
    what: "appends a line to the gate after its rows; the copy itself is otherwise unchanged",
    mutatesGate: true,
    patch: () => patched("// assert-bundle-fresh — ", "// assert-bundle-fresh  — "),
    expect: [],
    causes: [],
    reason: /./,
    expectRejection: /GATE MUTATED/,
  },
  {
    name: "ctl-single-outfile",
    what: "ambiguity guard: outs.length !== 1 -> false",
    patch: () => patched("if (outs.length !== 1) {", "if (false) {"),
    expect: ["two --outfile flags", "--outdir, no single outfile"],
    causes: ["code"],
    reason: /exit 1, expected 2/,
  },
  {
    name: "ctl-declared",
    what: 'the set of names taken from scripts["assert-bundle"] -> empty',
    patch: () =>
      patched(
        'const declared = [...new Set(assertedRaw.filter((t) => t.endsWith(".bundle.mjs")))];',
        "const declared = [];",
      ),
    // Declared from measurement, not prediction: the third row is here because emptying `declared` removes the
    // outside-root name, so the mixed row stops being a 2 at all and collapses to a stale verdict at exit 1.
    expect: ["ghost named in assert-bundle", "declared name resolves outside root", "stale artefact AND a declared name outside root"],
    causes: ["code"],
    reason: /exit \d, expected \d/,
  },
  {
    name: "ctl-wording",
    what: "the one exit-2 helper worded as a verdict again",
    patch: () => patched("CANNOT AUDIT — ${reason}", "FAIL  ${reason}"),
    expect: EXIT2_ROWS,
    // Two components, and the split is measured rather than reasoned: rows whose message assertion names the
    // CANNOT AUDIT text fail on `match`; the rest still satisfy their own message and fail on the structural
    // property, because stderr no longer *ends* on a CANNOT AUDIT line.
    causes: ["match", "derived"],
    reason: /no \/CANNOT AUDIT|stderr ended on/,
  },
  {
    name: "ctl-ends-on-other-line",
    what: "a second stderr line after it — matched text intact, so only (a) can flip",
    patch: () =>
      patched(
        "  console.error(`assert-bundle-fresh: CANNOT AUDIT — ${reason}; remedy: ${remedy}`);",
        '  console.error(`assert-bundle-fresh: CANNOT AUDIT — ${reason}; remedy: ${remedy}`);\n  console.error("assert-bundle-fresh: giving up");',
      ),
    expect: EXIT2_ROWS,
    causes: ["derived"],
    reason: /stderr ended on/,
  },
  {
    name: "ctl-trailing-verdict",
    what: "a summary line on stdout after it — only (b) can flip",
    patch: () =>
      patched(
        "  console.error(`assert-bundle-fresh: CANNOT AUDIT — ${reason}; remedy: ${remedy}`);",
        '  console.error(`assert-bundle-fresh: CANNOT AUDIT — ${reason}; remedy: ${remedy}`);\n  console.log("assert-bundle-fresh: OK (0 on disk, 0 verified)");',
      ),
    expect: EXIT2_ROWS,
    causes: ["derived"],
    reason: /the word OK appeared/,
  },
  {
    name: "ctl-separator",
    what: "the separator -> ` - `, a string the content can spell",
    patch: () => patched("; remedy: ${remedy}", " - ${remedy}"),
    expect: EXIT2_ROWS,
    causes: ["derived"],
    reason: /separators/,
  },
  {
    // Same patch as ctl-separator, declared with the WRONG derived property. Under axes 2 and 3 alone this is
    // indistinguishable from a real control — same set, same cause — which is what makes axis 4 load-bearing.
    // Measured before this row existed: deleting the reason check changed nothing, 6/6 still green. A check
    // whose deletion is not caught by anything is decoration.
    name: "meta-wrong-reason",
    what: "a true patch with a false derived-property declaration",
    patch: () => patched("; remedy: ${remedy}", " - ${remedy}"),
    expect: EXIT2_ROWS,
    causes: ["derived"],
    reason: /the word OK appeared/,
    expectRejection: /REASON/,
  },
  {
    // A declaration that is false about the SET: `ctl-single-outfile` neuters one guard, but that guard has two
    // observable consequences and this row names only the first. Measured before this row existed: deleting the
    // set check changed nothing either — 6/6 stayed green — so axis 2 was decoration too.
    name: "meta-wrong-set",
    what: "a true patch with a false failing-set declaration",
    patch: () => patched("if (outs.length !== 1) {", "if (false) {"),
    expect: ["two --outfile flags"],
    causes: ["code"],
    reason: /exit 1, expected 2/,
    expectRejection: /SET/,
  },
  {
    // The ONLY way the digest check can fire: a control that returns the source unchanged without going through
    // `patched()`. Every other control calls `patched()`, which throws first, so until this row existed the
    // digest check was unreachable — and the peer's rule (a check is load-bearing iff something's only reason to
    // fail is that check) makes an unreachable check a defect rather than a disclosed limit.
    name: "meta-noop",
    what: "a control whose patch changes no bytes at all",
    patch: () => original,
    expect: [],
    causes: [],
    reason: /./,
    expectRejection: /PATCH NOOP/,
  },
  {
    // A meta-control: everything axis 1 and 2 can see, and no property touched at all.
    name: "meta-wrong-cause",
    what: "exit code changed instead of any property; the declaration below is deliberately FALSE",
    patch: () => patched("  process.exit(2);", "  process.exit(1);"),
    expect: EXIT2_ROWS,
    causes: ["derived"],
    reason: /the word OK appeared/,
    expectRejection: /WRONG CAUSE/,
  },
];

function runSelftest(gateSource) {
  const dir = join(scratch, `c${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, "assert-bundle-fresh.mjs");
  writeFileSync(copy, gateSource);
  let out;
  try {
    out = execFileSync(process.execPath, [selftest], {
      encoding: "utf8",
      env: { ...process.env, GATE_UNDER_TEST: copy },
      stdio: "pipe",
    });
  } catch (error) {
    out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const failing = out
    .split("\n")
    .filter((line) => line.trimStart().startsWith("FAIL  "))
    .map((line) => {
      const [label, ...why] = line.trim().slice(6).split(" — ");
      return { label: label.trim(), why: why.join(" — ") };
    });
  return { failing, digest: sha(read(copy)) };
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

let bad = 0;
let rejected = 0;
// Counters kept per unit. The previous summary read `${guards - bad}/${guards}`, which subtracted inventory
// failures from the control tally — two units in one number, the defect this file exists to catch, in its own
// final line. A count is a claim about work performed.
let inventoryPass = 0;
// Which controls dirtied the copy with their OWN mutation, and which only FOUND it dirty. Kept apart because one
// list conflated them: deleting the repair was reported as a pile of controls that had done nothing, and a red
// line naming the wrong culprit is one level past a red line naming nobody.
const mutatedBy = [];
const repairWitnesses = [];
let lastFinished = null;
const inventoryTotal = 4;
let guardsPass = 0;
let metasPass = 0;

// --- axes 0: the inventories ------------------------------------------------------------------------------
// The counts are declared per row, so a "must be zero" invariant is expressible. The third one is the static
// form of the containment the run measures dynamically: whatever the code does at runtime, no line in this file
// may name the gate as a write target.
for (const [what, needle, expected] of [
  ["exit-two site", "process.exit(2)", 1],
  ["separator", "; remedy: ", 1],
  ["write to the gate path", "FileSync(gatePath,", 0],
]) {
  const count = occurrencesOutsideComments(original, needle);
  if (count === expected) {
    inventoryPass += 1;
    console.log(
      expected === 0
        ? `  ok    no ${what} outside comments — the gate is never a write target`
        : `  ok    one ${what} outside comments — grep for it is the whole surface`,
    );
  } else {
    bad += 1;
    console.log(
      `  FAIL  ${count} ${what}(s) outside comments, expected ${expected}; a comment that spells it breaks the inventory`,
    );
  }
}

for (const control of controls) {
  const previousControl = lastFinished;
  lastFinished = control.name;
  let gateSource;
  try {
    gateSource = control.patch();
  } catch (error) {
    bad += 1;
    console.log(`  FAIL  ${control.name} — ${String(error.message).slice(0, 120)}`);
    continue;
  }
  const patchedDigest = sha(gateSource);
  const noopPatch = patchedDigest === before;
  // Nothing to test when the patch produced no change — so the suite is not run, and the rejection is built from
  // the fact rather than from an empty run.
  const observed = noopPatch ? { failing: [] } : runSelftest(gateSource);

  // Did THIS control dirty the copy, or find it dirty? The second is a witness, and the culprit is whatever ran
  // before it — the control whose repair did not run. Conflating the two blames the innocent.
  const dirtyBefore = sha(read(gateCheck)) !== before;
  if (dirtyBefore) {
    writeFileSync(gateCheck, original);
    repairWitnesses.push({ witness: control.name, culprit: previousControl ?? "none" });
  }

  // Repair BEFORE the verdict, per control. A corrupted copy poisons every later measurement, so an end-of-run
  // check would be reporting on a run that is already worthless — and the report must be about the repaired
  // file, which is why the write comes first and the verdict second.
  if (control.mutatesGate) appendFileSync(gateCheck, MUTATION_LINE);
  const gateAfterControl = sha(read(gateCheck));
  const gateMutated = gateAfterControl !== before;
  if (gateMutated) {
    writeFileSync(gateCheck, original);
    mutatedBy.push(control.name);
  }
  const observedLabels = observed.failing.map((f) => f.label);
  const missing = control.expect.filter((label) => !observedLabels.includes(label));
  const extra = observedLabels.filter((label) => !control.expect.includes(label));
  const owned = observed.failing.filter((f) => control.expect.includes(f.label));
  const observedCauses = [...new Set(owned.map((f) => causeOf(f.why)))].sort();
  const declaredCauses = [...control.causes].sort();
  const causesOk = sameSet(observedCauses, declaredCauses);
  const wrongReason = owned.filter((f) => !control.reason.test(f.why));

  const setOk = missing.length === 0 && extra.length === 0;
  const wrongCauseDetail = owned
    .filter((f) => !declaredCauses.includes(causeOf(f.why)))
    .map((f) => `${f.label} (${causeOf(f.why)})`);

  // The rejection text the runner would print, built rather than inferred: the first version of this row tested
  // `JSON.stringify({wrongCauseDetail})` for the words `WRONG CAUSE`, which that string never contains — a
  // self-test asserting a token absent from the thing it inspects, in a file about exactly that defect.
  const rejectionText = [
    noopPatch ? `PATCH NOOP ${control.name} produced a copy byte-identical to the gate` : "",
    gateMutated ? `GATE MUTATED ${control.name} left the copy at ${gateAfterControl}; repaired from the text read before this run` : "",
    setOk ? "" : `SET ${[...missing, ...extra].join(", ")}`,
    causesOk ? "" : `WRONG CAUSE ${wrongCauseDetail.join(", ")}`,
    wrongReason.length ? `REASON ${wrongReason.map((f) => f.label).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (control.expectRejection) {
    // This row PASSES when the runner rejects it, and the rejection must be about cause — a rejection for any
    // other reason would mean the cause check is load-bearing by accident.
    if (rejectionText && control.expectRejection.test(rejectionText)) {
      rejected += 1;
      metasPass += 1;
      // Name the axis that did the rejecting rather than a fixed string: the first version printed "WRONG CAUSE"
      // for every meta-row, including the one rejected on REASON.
      const axis = rejectionText.match(/^(PATCH NOOP|GATE MUTATED|SET|WRONG CAUSE|REASON)/)?.[1] ?? "?";
      // Name what it SAW, not only which check fired: the peer's rule, and the reason my first version of this
      // line was useless — "rejected on WRONG CAUSE" is an exit code with no message.
      console.log(
        `  ok    ${control.name}  rejected on ${axis} — ${rejectionText.slice(0, 96)}`,
      );
    } else {
      bad += 1;
      console.log(`  FAIL  ${control.name} — a control with a false declaration was NOT rejected on cause`);
      console.log(`        observed causes ${observedCauses.join("|")} vs declared ${declaredCauses.join("|")}`);
    }
    continue;
  }

  if (setOk && causesOk && wrongReason.length === 0) {
    guardsPass += 1;
    console.log(
      `  ok    ${control.name}  ${control.expect.length}/16 rows  cause=[${declaredCauses.join("|")}]`,
    );
  } else {
    bad += 1;
    console.log(`  FAIL  ${control.name} — ${control.what}`);
    if (missing.length) console.log(`        did not fail: ${missing.join(", ")}`);
    if (extra.length) console.log(`        failed unexpectedly: ${extra.join(", ")}`);
    if (!causesOk) {
      console.log(`        WRONG CAUSE  declared ${declaredCauses.join("|")}, observed ${observedCauses.join("|")}`);
      for (const detail of wrongCauseDetail.slice(0, 10)) console.log(`          ${detail}`);
    }
    for (const f of wrongReason) console.log(`        wrong reason for ${f.label}: ${f.why.slice(0, 90)}`);
  }
}

// --- axis 5: containment — the controls never write the gate ------------------------------------------------
// Printed as a FACT. This assertion has no in-suite owner on purpose: the only control that could fire it would
// have to write to the real gate, which is the hazard containment removes — so its falsifier is external,
// `probe-abort` in the deletion audit, which appends then aborts and requires this file byte-identical. A control
// that reintroduces the hole in order to prove the hole is closed is worse than an assertion graded by a probe.
const realAfter = sha(read(gatePath));
if (realAfter !== before) {
  bad += 1;
  console.log(
    `  FAIL  real-gate — MODIFIED by the controls (${before} -> ${realAfter}); restore it before trusting this run`,
  );
} else {
  console.log(`  ok    real gate: unchanged (${before}) — the mutation lands on a per-run copy`);
}

// --- axis 6: attribution — who dirtied the copy, and who only found it dirty --------------------------------
if (repairWitnesses.length > 0) {
  bad += 1;
  const first = repairWitnesses[0];
  console.log(
    `  FAIL  gate-repair — ${first.witness} found the gate copy dirty before touching it: the previous control ` +
      `(${first.culprit}) left it modified and did not repair`,
  );
  console.log(
    `        ${repairWitnesses.length} witness(es), 0 controls blamed for another's dirt: ` +
      `${repairWitnesses.map((x) => x.witness).join(", ")}`,
  );
} else {
  console.log(`  ok    gate-repair — every control that read the copy found it clean`);
}

// --- the contract inventory: a path-taking helper must never be handed a Buffer ----------------------------
// The peer's `sha(readFileSync(gateCopy))` made a path function read the gate's own text as a filename, so the
// error message WAS 60 characters of the gate. "Read without an encoding" is not a countable literal — several
// reads here want a Buffer on purpose — but "a helper defined as (p) => … readFileSync(p) … is handed
// readFileSync(…)" is. Blind spot, stated: a path-taker written in another shape escapes it, so this is a guard
// with a known hole rather than a proof.
const pathHelpersIn = (text) =>
  [...text.matchAll(/const (\w+) = \((\w+)\) =>[^\n]*readFileSync\(\2[,)]/g)].map((m) => m[1]);
const bufferIntoPathHelper = (text) =>
  pathHelpersIn(text).flatMap((name) => {
    const hits = [...text.matchAll(new RegExp(`(^|[^\\w.])${name}\\(readFileSync\\(`, "gm"))];
    return hits.map(() => name);
  });
{
  // Scanned per file, because the identifier is per file. The gate's `sha` takes a PATH
  // (`update(readFileSync(p))`); the deletions script's `sha` takes TEXT. The exact expression
  // `sha(readFileSync(path, "utf8"))` therefore appears twice in this repo and is correct both times — while the
  // same text inside the gate would be the peer's defect. So a repo-wide grep flags working code (3 hits, 0
  // defects) and the contract is only decidable within a file. The deletions script is scanned because it defines
  // no path-taker today and its `sha(readFileSync(…))` lines would silently BECOME the bug the moment one is added.
  // The controls file itself is excluded for a reason worth stating: its positive-control fixture IS the pattern,
  // so a file holding the detector's own test data cannot be scanned by that detector without failing on itself.
  const scanned = [
    ["gate", original],
    ["deletions", read(join(here, "assert-bundle-fresh.deletions.mjs"))],
    ["selftest", read(selftest)],
  ];
  const found = scanned.flatMap(([file, text]) => bufferIntoPathHelper(text).map((name) => `${file}:${name}`));
  // Two controls, because they fail differently. The synthetic one proves the regex can parse a violation it was
  // handed; it says nothing about THIS file's helpers. The spliced one takes the real gate's own helper list and
  // appends a violation in its own vocabulary, so an empty `found` is a fact about this file rather than about a
  // fixture. A row with only the synthetic control is an assertion about a string I wrote to be caught.
  const positive =
    bufferIntoPathHelper(
      'const read = (p) => readFileSync(p, "utf8");\nconst bad = read(readFileSync(gate, "utf8"));\n',
    ).length > 0;
  const helpers = pathHelpersIn(original);
  const spliced = `${original}\nconst __falsifier = ${helpers[0] ?? "nothing"}(readFileSync(gatePath, "utf8"));\n`;
  const falsified = helpers.length > 0 && bufferIntoPathHelper(spliced).includes(helpers[0]);
  const contracts = scanned.map(([f, t]) => `${f}: ${pathHelpersIn(t).join("/") || "none"}`).join(", ");
  if (found.length === 0 && positive && falsified) {
    inventoryPass += 1;
    console.log(
      `  ok    contract: no path-taking helper is handed a Buffer (${contracts}; ` +
        `synthetic control fires: ${positive}; spliced into this gate: ${falsified})`,
    );
  } else {
    bad += 1;
    console.log(
      `  FAIL  contract: ${found.join(", ") || "no violation found"}, synthetic control fires: ${positive}, ` +
        `spliced into this gate: ${falsified} — all three must hold or this row proves nothing`,
    );
  }
}

const metaCount = controls.filter((c) => c.expectRejection).length;
const guardCount = controls.length - metaCount;
// Every tally is printed on every run, pass or fail, and each names its own unit. A skipped or failed check is
// visible as a number below its total rather than folded into a subtraction.
console.log(
  `assert-bundle-fresh controls: ${inventoryPass}/${inventoryTotal} inventories, ` +
    `${guardsPass}/${guardCount} guard controls, ${metasPass}/${metaCount} meta-controls rejected` +
    `${bad === 0 ? "" : `, ${bad} failure(s)`}`,
);
// A disclosure is printed on EVERY run, pass or fail. The peer named this: the catch around `control.patch()` is
// load-bearing, and its detector is the process dying rather than a row — so a reader of the summary above cannot
// tell a suite that would die from one that would name the culprit. Leaving that unstated would make the summary
// a claim of full coverage. It is a residual because the structural fix (run each control in a child and grade
// "child exited non-zero, naming control X") is a different piece of work, not a line.
console.log(
  "assert-bundle-fresh disclosed: 1 residual — the patch-throw catch is load-bearing with no graded row " +
    "(delete it and the suite dies instead of naming the control)",
);
process.exit(bad === 0 ? 0 : 1);
