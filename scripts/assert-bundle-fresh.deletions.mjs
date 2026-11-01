// assert-bundle-fresh.deletions — is each check in the controls file load-bearing?
//
// The rule, from the peer: **a check is load-bearing iff something exists whose only reason to fail is that
// check.** So each deletion here removes exactly one check from a COPY of the controls file and requires that:
//
//   * the copy still reaches its summary line — an unparseable or crashing copy also exits 1, and a status-only
//     grading would report that as "went red without it", certifying the check on evidence about the mutation
//     rather than about the check (the peer measured exactly this in its own audit);
//   * the only failing row is the meta-control that owns the check, named in the copy's own FAIL lines. A
//     deletion that turns three rows red for unrelated reasons is not evidence about this check.
//
// Two probes grade the grader: a deliberately broken copy must be refused as a CRASH, and a deletion graded
// against the wrong owner must be refused as a wrong owner. Without them this file is an assertion about its
// own plumbing, which is how both of us shipped a self-test that asserted a token absent from what it inspected.
//
//   node scripts/assert-bundle-fresh.deletions.mjs
//
// Exit 0 = every deletion flipped exactly its owning row, and both probes were refused for the right reason.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const here = resolve(dirname(new URL(import.meta.url).pathname));
const controlsPath = join(here, "assert-bundle-fresh.controls.mjs");

const original = readFileSync(controlsPath, "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const before = sha(original);

const scratch = mkdtempSync(join(tmpdir(), "bundle-fresh-deletions-"));
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

const SUMMARY = /^assert-bundle-fresh controls: (.*)$/m;
const FAIL_LINE = /^\s+FAIL\s+(.+?)\s+—/;

const DELETIONS = [
  {
    name: "del-set",
    what: "the failing-set check: setOk -> true",
    from: "  const setOk = missing.length === 0 && extra.length === 0;",
    to: "  const setOk = true;",
    owner: "meta-wrong-set",
  },
  {
    name: "del-cause",
    what: "the cause check: causesOk -> true",
    from: "  const causesOk = sameSet(observedCauses, declaredCauses);",
    to: "  const causesOk = true;",
    owner: "meta-wrong-cause",
  },
  {
    name: "del-reason",
    what: "the reason check: wrongReason -> []",
    from: "  const wrongReason = owned.filter((f) => !control.reason.test(f.why));",
    to: "  const wrongReason = [];",
    owner: "meta-wrong-reason",
  },
  {
    name: "del-noop",
    what: "the patch-noop check: noopPatch -> false",
    from: "  const noopPatch = patchedDigest === before;",
    to: "  const noopPatch = false;",
    owner: "meta-noop",
  },
];

function mutate(source, from, to) {
  if (!source.includes(from)) throw new Error(`deletion anchor moved: ${from.slice(0, 60)}`);
  const next = source.replace(from, to);
  if (next === source) throw new Error(`deletion changed nothing: ${from.slice(0, 60)}`);
  return next;
}

const gateOriginal = readFileSync(join(here, "assert-bundle-fresh.mjs"), "utf8");

function runControls(source, label) {
  const copy = join(scratch, `${label}.mjs`);
  const gateCopy = join(scratch, `${label}-gate.mjs`);
  writeFileSync(copy, source);
  writeFileSync(gateCopy, gateOriginal); // fresh per run: a corrupted copy must not leak into the next deletion
  let result;
  try {
    const stdout = execFileSync(process.execPath, [copy], {
      encoding: "utf8",
      stdio: "pipe",
      // The copy lives here, but must audit the gate that lives with the original — and the gate it mutates is a
      // COPY, so a mutation that escapes the repair corrupts a temp file instead of the instrument.
      env: { ...process.env, BUNDLE_FRESH_HERE: here, BUNDLE_FRESH_GATE: gateCopy },
    });
    result = { status: 0, out: stdout };
  } catch (error) {
    result = { status: error.status ?? "signal", out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
  return { ...result, gateCopyChanged: readFileSync(gateCopy, "utf8") !== gateOriginal, gateCopy };
}

/** Grade one deletion. The evidence must be the copy's own summary plus its named failing rows. */
function grade(run, owner) {
  const summary = run.out.match(SUMMARY);
  if (!summary) {
    return { ok: false, why: `exited ${run.status} with no summary — a CRASH is not a red verdict` };
  }
  if (run.status !== 1) {
    return { ok: false, why: `exited ${run.status} — a deletion that leaves the suite green is decoration` };
  }
  const failLines = run.out.split("\n").filter((line) => /^\s+FAIL\b/.test(line));
  const owners = failLines.map((line) => line.match(FAIL_LINE)?.[1]).filter(Boolean);
  if (owners.length !== failLines.length) {
    // The first `del-restore` run exited 1 with zero named failures for exactly this reason: the integrity line
    // printed a bare `FAIL …` with no unit, and this parser dropped it. A red line no reader can attribute is
    // not evidence, so it is refused rather than ignored.
    return {
      ok: false,
      why: `${failLines.length - owners.length} FAIL line(s) name no unit — a red line without a name is not evidence`,
    };
  }
  if (!owners.includes(owner)) {
    return {
      ok: false,
      why: `failed [${owners.join(", ") || "nothing"}] — not the row that owns this check (${owner})`,
    };
  }
  const extra = owners.filter((name) => name !== owner);
  if (extra.length > 0) {
    return { ok: false, why: `also failed ${extra.join(", ")} — one deletion, one owner` };
  }
  return { ok: true, why: `only ${owner} failed: ${summary[1].slice(0, 76)}` };
}

// `BUNDLE_FRESH_NO_DELETIONS=1` skips the work. It must then print NO tally at all: a count is a claim about
// work performed, and skipped work has no count — the peer found its own summary printing `4/4 deletions` for
// four deletions that never ran.
if (process.env.BUNDLE_FRESH_NO_DELETIONS === "1") {
  console.log("assert-bundle-fresh deletions: skipped (BUNDLE_FRESH_NO_DELETIONS=1) — this is not a tally");
  process.exit(0);
}

let bad = 0;
let loadBearing = 0;
// Counted, not declared. The peer's tally printed `6/6 deletions` on a run that crashed before the first mutant
// had executed — a numerator taken from the list it was about to walk. Here a row is only a pass if `grade()`
// returned a verdict for it, and the denominator is how many verdicts exist, with the rest named as unmeasured.
let measured = 0;
let probesRefused = 0;

// Phase attribution. A crash inside a phase used to be attributable to whatever ran last — the peer had a crash
// in its deletion audit reported as `FAIL meta-throw`, the final control of a loop that had already passed. A
// red line naming the wrong unit is worse than one naming none, so every phase announces itself and an
// uncaught error names the phase it died in rather than dying with a stack trace that reads as a red verdict.
let phase = "startup";
process.on("uncaughtException", (error) => {
  console.log(`  FAIL  ${phase} — harness error: ${String(error?.message ?? error).slice(0, 140)}`);
  console.log(
    `assert-bundle-fresh deletions: harness error in ${phase} — ${measured} row(s) measured before it; ` +
      `a crash is not a verdict`,
  );
  process.exit(1);
});

phase = "deletions";
for (const deletion of DELETIONS) {
  let source;
  try {
    source = mutate(original, deletion.from, deletion.to);
  } catch (error) {
    bad += 1;
    console.log(`  FAIL  ${deletion.name} — ${error.message.slice(0, 110)}`);
    continue;
  }
  const run = runControls(source, deletion.name);
  // Containment applied to every mutant, not only to del-restore: the child is handed a gate copy and must not
  // write it. The peer named this as its residual — its assertion covers the real gate only, so a mutant that
  // corrupted its own copy and then stopped would pass there. Here it is a failed row.
  if (run.gateCopyChanged) {
    bad += 1;
    console.log(
      `  FAIL  ${deletion.name} — the mutant wrote the gate copy it was handed; containment is that the child ` +
        `writes nothing outside its own scratch`,
    );
  }
  const verdict = grade(run, deletion.owner);
  measured += 1;
  if (verdict.ok) {
    loadBearing += 1;
    console.log(`  ok    ${deletion.name}  ${deletion.what}  ->  ${verdict.why}`);
  } else {
    bad += 1;
    console.log(`  FAIL  ${deletion.name} — ${deletion.what}`);
    console.log(`        ${verdict.why}`);
  }
}

// --- the repair is load-bearing, and deleting it blames only the repair ---------------------------------
// Deleting the repair no longer collapses the run: the dirty copy is caught and repaired by the NEXT control,
// which records a WITNESS and names the control whose repair did not run. So the evidence is one unit —
// `gate-repair` — and the assertion that matters is that no other control is blamed for dirt it did not make.
// The peer measured the version this replaces: one cause, seven names, none of them the cause.
phase = "del-restore";
{
  let run = null;
  try {
    run = runControls(
      mutate(
        original,
        "    writeFileSync(gateCheck, original);\n    mutatedBy.push(control.name);",
        "    /* repair deleted by the audit */\n    mutatedBy.push(control.name);",
      ),
      "del-restore",
    );
  } catch (error) {
    // An anchor that moved is a red row, not a crash: a thrown exception here would report the audit's own
    // failure as if it were a measurement, which is the defect this file grades against.
    bad += 1;
    console.log(`  FAIL  del-restore — ${String(error.message).slice(0, 110)}`);
  }
  if (run) {
    measured += 1;
    const summary = run.out.match(SUMMARY);
    const failLines = run.out.split("\n").filter((line) => /^\s+FAIL\b/.test(line));
    const owners = failLines.map((line) => line.match(FAIL_LINE)?.[1]).filter(Boolean);
    const unnamed = failLines.length - owners.length;
    const repairLine = run.out.split("\n").find((line) => /^\s+FAIL\s+gate-repair\b/.test(line)) ?? "";
    const realGateIntact = sha(readFileSync(join(here, "assert-bundle-fresh.mjs"), "utf8")) === sha(gateOriginal);
    // Only the repair may be blamed. Any other name here is a bystander, which is what this grades.
    const blamedOthers = owners.filter((name) => name !== "gate-repair");
    if (!summary) {
      bad += 1;
      console.log(`  FAIL  del-restore — exited ${run.status} with no summary — a CRASH is not a red verdict`);
    } else if (unnamed > 0) {
      bad += 1;
      console.log(
        `  FAIL  del-restore — ${unnamed} FAIL line(s) name no unit — a red line without a name is not evidence`,
      );
    } else if (run.status !== 1 || !owners.includes("gate-repair")) {
      bad += 1;
      console.log(
        `  FAIL  del-restore — exit ${run.status}, failing [${owners.join(", ") || "nothing"}]; the repair must ` +
          `show up as a named gate-repair failure`,
      );
    } else if (blamedOthers.length > 0) {
      bad += 1;
      console.log(
        `  FAIL  del-restore — failing [${owners.join(", ")}]: ${blamedOthers.join(", ")} blamed for a repair that never ran`,
      );
    } else if (!realGateIntact || run.gateCopyChanged) {
      bad += 1;
      console.log(
        `  FAIL  del-restore — containment failed: real gate intact=${realGateIntact}, audit copy ` +
          `written=${run.gateCopyChanged}`,
      );
    } else {
      loadBearing += 1;
      console.log(
        `  ok    del-restore  the repair, deleted  ->  exit 1, failing [gate-repair]; 0 controls blamed for another's dirt`,
      );
      if (repairLine) console.log(`        ${repairLine.trim().slice(0, 148)}`);
      console.log(`        REAL gate byte-identical · the audit's gate copy never written  (containment holds)`);
    }
  }
}

// --- probe-abort: the containment fact needs an owner, and it cannot live inside the suite ---------------
// The controls file prints `real gate: unchanged` as a fact. By our own rule an unowned assertion is decoration,
// and its only possible in-suite owner would have to write to the real gate — the hazard containment exists to
// remove. So the owner lives out here: a copy that appends the mutation and then ABORTS, run against the real
// gate with no copy to hide behind. The peer measured the pre-containment version this way: exit 3, real gate
// 16386 -> 16466 bytes. The probe restores from memory before reporting, so a regression here cannot leave the
// instrument broken.
//
// The probe reads its append TARGET out of the source instead of assuming it. The first version anchored on the
// literal `appendFileSync(gateCheck, MUTATION_LINE)`, which only matches a harness that already has the fix — run
// against the broken form it would have refused with "anchor moved", and a probe that only runs on fixed code is
// vacuous by construction. The peer hit exactly this and named it. Now the shape is matched, the target is
// whichever identifier it names, and a harness that appends to `gatePath` is DETECTED rather than refused.
let containment = false;
phase = "probe-abort";
{
  const APPEND = /if \(control\.mutatesGate\) appendFileSync\((\w+), MUTATION_LINE\);/;
  const target = original.match(APPEND)?.[1] ?? null;

  // Splice an abort immediately after the append, aimed at whatever target is asked for. The abort is what makes
  // the window real: a harness that repairs two lines later is indistinguishable from a safe one until it dies
  // in between.
  const stageAbort = (appendTarget, label) => {
    const source = original.replace(
      APPEND,
      `if (control.mutatesGate) {\n    appendFileSync(${appendTarget}, MUTATION_LINE);\n    process.exit(3);\n  }`,
    );
    if (source === original) throw new Error(`the append shape moved: ${APPEND}`);
    const path = join(scratch, `${label}.mjs`);
    writeFileSync(path, source);
    return path;
  };

  const runAbort = (path, env) => {
    try {
      execFileSync(process.execPath, [path], { encoding: "utf8", stdio: "pipe", env });
      return 0;
    } catch (error) {
      return error.status ?? "signal";
    }
  };

  const realGate = join(here, "assert-bundle-fresh.mjs");
  const noCopy = { ...process.env, BUNDLE_FRESH_HERE: here };
  delete noCopy.BUNDLE_FRESH_GATE; // no copy to hide behind: containment must hold against the real path

  let statusA = "not run";
  let intact = true;
  let statusB = "not run";
  let corrupted = false;
  try {
    if (!target) throw new Error("no append site matched the shape — nothing to point the abort at");

    // A. the harness as it stands, aborted right after its own append, against the real path.
    statusA = runAbort(stageAbort(target, "probe-abort"), noCopy);
    intact = readFileSync(realGate, "utf8") === gateOriginal;
    if (!intact) writeFileSync(realGate, gateOriginal); // the probe repairs; the mutant never does

    // B. the same splice aimed at the gate path and handed a gate copy. If the copy is not corrupted, A's
    // "unchanged" would pass just as happily when nothing was written, and this probe would prove nothing.
    const positiveGate = join(scratch, "probe-abort-gate.mjs");
    writeFileSync(positiveGate, gateOriginal);
    statusB = runAbort(stageAbort("gatePath", "probe-abort-direct"), {
      ...process.env,
      BUNDLE_FRESH_HERE: here,
      BUNDLE_FRESH_GATE: positiveGate,
    });
    corrupted = readFileSync(positiveGate, "utf8") !== gateOriginal;
  } catch (error) {
    bad += 1;
    console.log(`  FAIL  probe-abort — ${String(error.message).slice(0, 120)}`);
  }

  if (!target) {
    /* already reported above */
  } else if (statusA === 3 && intact && statusB === 3 && corrupted) {
    containment = true;
    console.log(`  ok    probe-abort  exit 3 after the mutation append · REAL gate byte-identical (${sha(gateOriginal)})`);
    console.log(`        the append target was read from the source, not assumed: \`${target}\``);
    console.log(`  ok    probe-abort-sees  the same splice aimed at a gate copy left it modified (exit ${statusB})`);
  } else {
    bad += 1;
    console.log(
      `  FAIL  probe-abort — exit ${statusA} (3 = the append ran, then the process died) · REAL gate intact=${intact}` +
        (intact ? "" : " — restored from the text read before the audit"),
    );
    console.log(
      `        the append targets \`${target}\` — containment requires a per-run copy, never the gate path`,
    );
    console.log(
      `        positive control: exit ${statusB}, gate copy corrupted=${corrupted} — both runs must hold or "intact" proves nothing`,
    );
  }
}

// --- the two probes: grade the grader ----------------------------------------------------------------
const probes = [
  {
    name: "probe-crash",
    what: "a copy that cannot parse must be refused as a CRASH, not accepted as red",
    run: () => runControls(mutate(original, "let bad = 0;", "let bad = ;"), "probe-crash"),
    accept: /a CRASH is not a red verdict/,
  },
  {
    name: "probe-wrong-owner",
    what: "a deletion graded against the wrong owner must be refused on ownership",
    run: () => runControls(mutate(original, DELETIONS[1].from, DELETIONS[1].to), "probe-owner"),
    accept: /not the row that owns this check/,
  },
];

phase = "probes";
for (const probe of probes) {
  const verdict = grade(probe.run(), "meta-wrong-set");
  if (!verdict.ok && probe.accept.test(verdict.why)) {
    probesRefused += 1;
    console.log(`  ok    ${probe.name}  refused: ${verdict.why.slice(0, 92)}`);
  } else {
    bad += 1;
    console.log(`  FAIL  ${probe.name} — ${probe.what}`);
    console.log(`        grade() said: ${verdict.ok ? "ACCEPTED" : verdict.why}`);
  }
}

const after = sha(readFileSync(controlsPath, "utf8"));
if (after !== before) {
  bad += 1;
  console.log(`  FAIL  the controls file was modified by the audit (${before} -> ${after})`);
} else {
  console.log(`  ok    controls file unchanged by the audit (${before})`);
}

const declared = DELETIONS.length + 1;
const unmeasured = declared - measured;
console.log(
  `assert-bundle-fresh deletions: ${loadBearing}/${measured} measured load-bearing` +
    `${unmeasured > 0 ? `, ${unmeasured} NEVER MEASURED` : ""}, ` +
    `${probesRefused}/${probes.length} probes refused, ` +
    `containment ${containment ? "proven against the real gate" : "NOT PROVEN"}, ` +
    `1 disclosed residual (the patch-throw catch has no graded row: deleting it kills the suite instead of ` +
    `naming the control)` +
    `${bad === 0 ? "" : `, ${bad} failure(s)`}`,
);
process.exit(bad === 0 ? 0 : 1);
