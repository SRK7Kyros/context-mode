// assert-bundle-fresh — the freshness + coverage gate `assert-bundle.mjs` does not have.
//
// Three invariants, each of which was violated in this repo at some point:
//
//   FRESH    every shipped `*.bundle.mjs` is byte-identical to a rebuild of the current `src/` with the
//            flags `scripts.bundle` uses. A stale bundle wins over `src/` at runtime
//            (`hooks/session-loaders.mjs` L30-34: bundle -> build/ -> source), so DIFFERS means the code
//            being executed is not the code being read.
//   ORPHAN   every `*.bundle.mjs` on disk is produced by a step of `scripts.bundle`. A bundle nobody
//            builds is one nobody notices is stale.
//   COVERED  every `*.bundle.mjs` on disk is ALSO passed to `assert-bundle`.
//
// ORPHAN and COVERED are enumerated from the DIRECTORY, never from the two lists: comparing
// `outfiles ⊆ asserted` is vacuously true when both lists omit the same file, which is exactly how
// `hooks/session-attribution.bundle.mjs` sat unbuilt and unasserted for two months while the lists
// agreed with each other.
//
// Read-only apart from a temp directory.
//
//   0  the tree is clean   (freshness and coverage both hold)
//   1  the tree is broken  (a stale bundle, an orphan, a bundle in neither list)
//   2  I cannot run here   (wrong root in any of three shapes, unparseable manifest, or no esbuild)
//
// 2 never means 1: a tree this script could not examine is never reported as a tree that failed.
//
//   node scripts/assert-bundle-fresh.mjs [repo-root] [--keep]
//
// `repo-root` defaults to this script's parent, so it works from an npm script; pass it explicitly to
// audit a checkout you are not standing in (CI, or the other host's tree).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const argRoot = process.argv.slice(2).find((a) => !a.startsWith("--"));
const root = argRoot ? resolve(argRoot) : resolve(dirname(new URL(import.meta.url).pathname), "..");
// PRE-ORDER RULE — do not reorder this block. Every precondition the script dereferences is checked,
// in order, BEFORE it is dereferenced: manifest exists -> manifest parses -> manifest carries the two
// scripts -> esbuild is resolvable. Each unchecked precondition is a crash, and a crash exits 1, which
// is indistinguishable from "a bundle is stale" — a false verdict on a target that was never examined.
// 2 means "I cannot run here"; 1 means "the tree is broken". They must not be reachable from each other.
// MESSAGE RULE — every `exit 2` names the REMEDY, not only the fault. A correct exit code with a message
// that stops at "not found" still sends the reader to the wrong place, just more slowly: `2` is the code
// for "I could not examine this", so the message owes them the thing that would let it.
// One exit-two site, on purpose: a grep for it is then a complete inventory of the places this tool declines
// to answer. Eight sites were eight places to forget the wording, and the peer measured that drift on its own
// file — five prefixes for one meaning before it collapsed them into one call. The comment does not spell the
// token, because a comment that spells it makes the grep count two.
//
// Two shape decisions, both from its measurements:
//  - the separator is a counted claim, and this comment does not spell it: a comment that spells a token
//    satisfies a grep for that token, which made the inventory read two (measured, in the peer's file and then
//    in this one). It is safer than ` - ` because it appears exactly once on the line, not because it is
//    unusual — its JSON error message carried hyphens, so `A - B - C` had three and no way to tell reason from
//    remedy. An em dash fails the same count, since a path or a message may contain one.
//  - stderr, not stdout. This is a diagnostic, not a result, and "the report ends on the CANNOT AUDIT line"
//    is only a property of the report if it is read from one stream — its harness concatenated stdout+stderr,
//    so that ordering was capture order rather than report order.
function cannotAudit(reason, remedy) {
  console.error(`assert-bundle-fresh: CANNOT AUDIT — ${reason}; remedy: ${remedy}`);
  process.exit(2);
}

const pkgPath = join(root, "package.json");
if (!existsSync(pkgPath)) {
  cannotAudit(
    `no package.json under ${root}`,
    "pass the repo root as an argument, or run this from the checkout",
  );
}
let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
} catch (err) {
  // Truncated / malformed manifest: `JSON.parse` throws, and the throw exits 1 like a stale bundle.
  cannotAudit(`${pkgPath} is not valid JSON`, "repair or restore that file, then re-run");
}
// A package.json is not enough: another project's root has one and no bundle scripts, and
// `pkg.scripts.bundle.split` then throws — which, through a pipe, reads as a pass. Wrong root is 2.
for (const key of ["bundle", "assert-bundle"]) {
  if (typeof pkg.scripts?.[key] !== "string") {
    cannotAudit(
      `${root} is not a context-mode checkout: no scripts.${key}`,
      "pass the repo root as an argument",
    );
  }
}
const keep = process.argv.includes("--keep");

const steps = pkg.scripts.bundle
  .split("&&")
  .map((s) => s.trim())
  .filter((s) => s.startsWith("esbuild"));
const normRel = (t) => t.replace(/^\.\//, "");
const assertedRaw = pkg.scripts["assert-bundle"].split(/\s+/).map(normRel).filter(Boolean);
const asserted = new Set(assertedRaw);
// `asserted` is every whitespace token — `node`, the script path, and the artefact paths — so counting it
// publishes a number that is not the number of artefacts (9 for a 7-bundle repo). `declared` is the tokens
// that name an artefact, and it is the only count this file reports.
//
// LIMIT, stated rather than papered over: COVERED proves the path is NAMED in `scripts["assert-bundle"]`,
// not that `assert-bundle.mjs` actually compares it. A path listed but skipped by that script would still
// read covered. Closing it means running the repo's own assert script — a second instrument with its own
// vacuity risk (a script that exits 0 having checked nothing) — so the meaning is labelled instead.
const declared = [...new Set(assertedRaw.filter((t) => t.endsWith(".bundle.mjs")))];
const esbuild = join(root, "node_modules", ".bin", "esbuild");
if (!existsSync(esbuild)) {
  // A missing binary is "cannot run here", not "stale": reporting FRESH here puts a build problem and a
  // stale artefact under the same exit code, and sends the reader to debug the wrong thing.
  cannotAudit(
    `no esbuild at ${esbuild}`,
    `run \`bun install\` in ${root}, or this host cannot audit this tree`,
  );
}

const outfileOf = (step) => step.match(/--outfile=(\S+)/)?.[1];

// A step must name exactly one output, and this is checked before any verdict is reached. esbuild honours
// the LAST `--outfile`, so a step carrying two is not a step an artefact can be attributed to: the file we
// would hash and the file esbuild writes are different files, and the comparison stops being about the
// artefact at all. Guessing which flag to trust is the bug, so ambiguity is 2 ("cannot audit here") and
// never 1 ("the bundle is broken"). Zero `--outfile` (an `--outdir` build) is the same shape: a step whose
// output path this tool cannot name would silently drop out of `produced`, and every artefact it builds
// would then be reported ORPHAN — a list standing in for the directory, one level down.
for (const step of steps) {
  const outs = step.match(/--outfile=\S+/g) ?? [];
  if (outs.length !== 1) {
    const why = outs.length === 0
      ? "no --outfile (an --outdir build cannot be verified file by file)"
      : `${outs.length} --outfile flags, and esbuild honours only the last`;
    cannotAudit(`"${step.slice(0, 72)}…": ${why}`, "give each esbuild step exactly one --outfile");
  }
}

// A step this tool never looked at is worse than a step it rejected: it silently drops out of `produced`,
// and every artefact it builds is reported ORPHAN — an accusation dressed as a verdict. So a non-esbuild
// segment that names a `.bundle.mjs` output is 2 ("cannot attribute this"), not 1 ("broken tree").
for (const raw of pkg.scripts.bundle.split("&&").map((r) => r.trim())) {
  if (raw && !raw.startsWith("esbuild") && /\.bundle\.mjs/.test(raw)) {
    cannotAudit(
      `"${raw.slice(0, 68)}…": a non-esbuild step names a bundle output`,
      "add it to this gate or move it out of scripts.bundle",
    );
  }
}

const produced = new Map(steps.map((s) => [outfileOf(s), s]).filter(([out]) => out));

const bundleDirs = [root, join(root, "hooks")];
const onDisk = bundleDirs
  .filter((d) => existsSync(d))
  .flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith(".bundle.mjs"))
      .map((f) => (d === root ? f : join(basename(d), f))),
  )
  .sort();

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
// MUST be a FRESH directory per run, and `mkdtempSync` is the mechanism, not tidiness. A shared temp dir
// makes a file left by a previous run indistinguishable from this run's output — the peer measured a real
// false PASS ("IDENTICAL … 39 B") on an artefact nothing had rebuilt. A directory that did not exist a
// moment ago cannot contain a planted file; change this to a stable path and the gate starts certifying
// whatever was already there.
const temp = mkdtempSync(join(tmpdir(), "bundle-fresh-"));

// `process.exit()` does not run `finally` blocks, so any `exit(2)` reached after this line used to leave the
// directory behind — the "no litter" property held only for the exit paths that happened to be inside the
// `try`. Registered on `exit` so every way out cleans up, including the ones that do not unwind.
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  if (keep) return;
  try { rmSync(temp, { recursive: true, force: true }); } catch { /* already gone */ }
};
process.on("exit", cleanup);

let failures = 0;
// Counts *comparisons that happened*, not steps in the manifest. `produced.size` was the old numerator and
// it could not fall — a step that was skipped still counted, which is how a summary of "built" reports a
// number that means nothing. Zero comparisons is "I could not audit", never "the tree is clean".
let verified = 0;
// Declared names that match nothing. Reported in the summary rather than left implicit in a failure count:
// the peer's form, so the two halves of "named" and "exists" can disagree visibly instead of averaged.
let phantoms = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`assert-bundle-fresh: FAIL  ${msg}`);
};

try {
  for (const out of onDisk) {
    const shipped = join(root, out);
    const step = produced.get(out);
    if (!step) fail(`ORPHAN   ${out} exists on disk but no bundle step produces it`);
    if (!asserted.has(out)) fail(`COVERED  ${out} exists on disk but is not named in scripts["assert-bundle"]`);
    if (!step) continue;

    // Flat but UNIQUE: `basename(out)` made two steps sharing a filename (`a.bundle.mjs` at the root and
    // under `hooks/`) share one temp path, so a step that wrote nothing inherited the previous step's
    // output — the peer's shared-temp-dir defect across steps instead of across runs, and the `existsSync`
    // guard below cannot detect it because the file does exist. The relative path is the identity.
    const fresh = join(temp, out.split(/[\\/]/).join("__"));
    const args = step
      .split(/\s+/)
      .slice(1) // token 0 is the `esbuild` command itself
      .map((a) => (a.startsWith("--outfile=") ? `--outfile=${fresh}` : a));
    try {
      execFileSync(esbuild, args, { cwd: root, stdio: "pipe" });
    } catch (error) {
      fail(`FRESH    ${out} failed to rebuild: ${String(error.stderr ?? error).slice(0, 120)}`);
      continue;
    }
    // Existence is not identity, and absence must not be a crash. Without this, a step that exits 0 having
    // written nothing makes `sha(fresh)` throw `ENOENT`, and an unhandled throw exits **1** — a crash
    // wearing the verdict "a bundle is stale". The per-run `mkdtempSync` already rules out the other half
    // (a leftover file mistaken for this run's output, since a fresh directory cannot contain one); this is
    // the case where this run produced nothing to compare at all.
    if (!existsSync(fresh)) {
      fail(`BUILD WROTE NOTHING  ${out}: esbuild exited 0 but wrote no file`);
      continue;
    }
    if (sha(fresh) !== sha(shipped)) {
      fail(`FRESH    ${out} is stale (shipped ${sha(shipped).slice(0, 12)}, rebuild ${sha(fresh).slice(0, 12)})`);
      continue;
    }
    verified += 1;
    // `VERIFIED`, not `OK`: the summary prints `OK (7 on disk, …)` for the whole tree, and one word carrying
    // two units is the same defect as `9 asserted` counting `node`. Selftest rule below: on exit 2 the word
    // OK must never appear, so the two cannot be confused by a reader or by a regex.
    console.log(`assert-bundle-fresh: VERIFIED  ${out} (${readFileSync(shipped).length} B)`);
  }

  for (const out of produced.keys()) {
    if (!onDisk.includes(out)) fail(`MISSING  ${out} is produced by a bundle step but absent from the tree`);
  }

  // The other asymmetry, and the last place a list stood in for the directory: a name in
  // `scripts["assert-bundle"]` that never becomes an artefact is asserted and unverifiable — measured
  // before this check, a clean tree plus `hooks/ghost.bundle.mjs` in that list exited **0**.
  const scannedRel = new Set([".", "hooks"]);
  for (const out of declared) {
    if (onDisk.includes(out)) continue;
    const dir = out.includes("/") ? out.slice(0, out.lastIndexOf("/")) : ".";
    if (!scannedRel.has(dir)) {
      // Two different reasons, two different remedies, the same code: the name escapes the root (a limit of
      // the instrument — widen the walk or audit by hand) or it sits in a directory inside the root that this
      // gate never enumerates (fixable here). Telling the reader "extend bundleDirs" for a path outside the
      // checkout would send them to edit the wrong thing.
      const escaped = !resolve(root, out).startsWith(root + sep);
      const reason = escaped
        ? `"${out}" resolves outside ${root}`
        : `"${out}" sits under ${dir}/, which this gate does not enumerate`;
      const remedy = escaped
        ? "widen the walk to cover it, or audit that artefact by hand"
        : `add ${dir}/ to bundleDirs`;
      // Exit 2 says "incomplete", and this line can be reached after artefacts were already judged: a stale
      // bundle listed above is a true finding, and the code alone would hide it. Say both things.
      const already = failures > 0 ? ` (${failures} artefact(s) above had already failed)` : "";
      cannotAudit(reason + already, remedy);
    }
    phantoms += 1;
    fail(`PHANTOM  ${out} is named in scripts["assert-bundle"] but no such artefact exists`);
  }
} finally {
  if (keep) console.log(`assert-bundle-fresh: kept ${temp}`);
  else cleanup();
}

// "PASS 0/0" is the most convincing-looking wrong answer this script can print, so it is unreachable.
if (failures === 0 && verified === 0) {
  cannotAudit(
    `no artefact was rebuilt and compared (${onDisk.length} on disk, ${produced.size} produced by a step)`,
    "check that scripts.bundle still builds the bundles this tree ships",
  );
}

const named = `${declared.length} named by assert-bundle${phantoms > 0 ? `, ${phantoms} naming nothing` : ""}`;
const counts = `${onDisk.length} on disk, ${verified} verified, ${named}`;
console.log(`assert-bundle-fresh: ${failures === 0 ? "OK" : `${failures} failure(s)`} (${counts})`);
process.exit(failures === 0 ? 0 : 1);
