// assert-bundle-fresh.selftest — one row per invariant, asserted by BEHAVIOUR.
//
// Why this file exists: a guard deleted during an edit cannot report its own absence. The peer hit exactly
// that — it replaced a block instead of adding beside it and the ambiguous-`--outfile` guard vanished, caught
// only by counting guards after the edit. Counting guards is still a proxy (the count is a note about the
// code); running each shape is not. Every row below is an existence proof of one check, and the row fails if
// the check is removed, if it exits with the wrong code, OR if it exits with the right code for the wrong
// reason — which is why each row asserts a message fragment too, not just a status.
//
//   node scripts/assert-bundle-fresh.selftest.mjs
//
// Exit 0 = every row behaved. Exit 1 = at least one row did not, with the row printed.
// Fixtures are created under a fresh mkdtemp and removed at exit; nothing in this repo is touched.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const here = resolve(dirname(new URL(import.meta.url).pathname));
// `GATE_UNDER_TEST` lets the controls run every row against a PATCHED COPY. Patching the real file and
// restoring it afterwards works only if nothing fails in between; a control that crashes leaves the gate
// mutated, which is worse than the thing it was measuring.
const gate = process.env.GATE_UNDER_TEST ? resolve(process.env.GATE_UNDER_TEST) : join(here, "assert-bundle-fresh.mjs");
const realEsbuild = join(here, "..", "node_modules", ".bin", "esbuild");

const scratch = mkdtempSync(join(tmpdir(), "bundle-fresh-selftest-"));
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

let nextId = 0;
/** Build a fixture root. `files` are written verbatim; `esbuild: true` links the real binary in. */
function fixture({ bundle, assert, files = {}, esbuild = true }) {
  const dir = join(scratch, `f${nextId++}`);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  if (esbuild) {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    symlinkSync(realEsbuild, join(dir, "node_modules", ".bin", "esbuild"));
  }
  if (bundle !== undefined || assert !== undefined) {
    const scripts = {};
    if (bundle !== undefined) scripts.bundle = bundle;
    if (assert !== undefined) scripts["assert-bundle"] = assert;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }));
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** Produce a real, reproducible artefact in `dir` so the freshness comparison has something true to say. */
function buildArtefact(dir, outRel = "hooks/a.bundle.mjs") {
  mkdirSync(dirname(join(dir, outRel)), { recursive: true });
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  execFileSync(join(dir, "node_modules", ".bin", "esbuild"), ["a.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${outRel}`], {
    cwd: dir,
    stdio: "pipe",
  });
}

const GOOD_BUNDLE = "esbuild a.ts --bundle --platform=node --format=esm --outfile=hooks/a.bundle.mjs";
const GOOD_ASSERT = "node scripts/assert-bundle.mjs hooks/a.bundle.mjs";

/** Streams kept apart: a property about "the last line of the report" is only about the report if it is read
 * from one stream. Concatenating stdout+stderr makes that ordering an artefact of the capture order. */
function gateRun(dir) {
  try {
    const stdout = execFileSync(process.execPath, [gate, dir], { stdio: "pipe", encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const rows = [];
const row = (label, expectedCode, expectedMatch, make) => rows.push({ label, expectedCode, expectedMatch, make });

row("clean tree", 0, /OK \(\d+ on disk, \d+ verified/, () => {
  const d = fixture({ bundle: GOOD_BUNDLE, assert: GOOD_ASSERT });
  buildArtefact(d);
  return d;
});

row("orphan bundle on disk", 1, /ORPHAN/, () => {
  const d = fixture({ bundle: GOOD_BUNDLE, assert: GOOD_ASSERT });
  buildArtefact(d);
  writeFileSync(join(d, "hooks", "zz-orphan.bundle.mjs"), "// nobody builds me\n");
  return d;
});

row("stale bundle", 1, /FRESH .* is stale/, () => {
  const d = fixture({ bundle: GOOD_BUNDLE, assert: GOOD_ASSERT });
  buildArtefact(d);
  writeFileSync(join(d, "hooks", "a.bundle.mjs"), "// shipped bytes that no build produces\n");
  return d;
});

row("wrong root, no manifest", 2, /no package\.json/, () => join(scratch, "does-not-exist"));

row("other repo, no scripts.bundle", 2, /no scripts\.bundle/, () =>
  fixture({ bundle: undefined, assert: undefined, files: { "package.json": '{"name":"x","scripts":{"test":"t"}}' } }),
);

row("invalid JSON manifest", 2, /is not valid JSON/, () =>
  fixture({ bundle: undefined, assert: undefined, files: { "package.json": '{"name":"x","scripts":{"bundle":' } }),
);

row("no esbuild binary", 2, /no esbuild at/, () => {
  const d = fixture({ bundle: GOOD_BUNDLE, assert: GOOD_ASSERT, esbuild: false });
  buildArtefact.length; // never built: the binary is absent on purpose
  writeFileSync(join(d, "hooks", "a.bundle.mjs"), "// shipped\n");
  return d;
});

row("two --outfile flags", 2, /CANNOT AUDIT — .*--outfile/, () =>
  fixture({ bundle: `${GOOD_BUNDLE} --outfile=hooks/b.bundle.mjs`, assert: GOOD_ASSERT }),
);

row("--outdir, no single outfile", 2, /CANNOT AUDIT — .*--outdir/, () =>
  fixture({ bundle: "esbuild a.ts --bundle --outdir=hooks", assert: GOOD_ASSERT }),
);

row("build writes nothing", 1, /BUILD WROTE NOTHING/, () => {
  const d = fixture({ bundle: "esbuild --version --outfile=hooks/a.bundle.mjs", assert: GOOD_ASSERT });
  writeFileSync(join(d, "hooks", "a.bundle.mjs"), "// shipped\n");
  return d;
});

row("non-esbuild step names a bundle", 2, /a non-esbuild step names a bundle output/, () =>
  fixture({ bundle: "tsc a.ts --outFile hooks/a.bundle.mjs", assert: GOOD_ASSERT }),
);

row("no rebuildable step at all", 2, /CANNOT AUDIT/, () =>
  fixture({ bundle: "tsc -p .", assert: "node scripts/assert-bundle.mjs" }),
);

row("declared outfile, build fails", 1, /failed to rebuild/, () => {
  const d = fixture({ bundle: "esbuild src/missing.ts --bundle --outfile=hooks/a.bundle.mjs", assert: GOOD_ASSERT });
  writeFileSync(join(d, "hooks", "a.bundle.mjs"), "// shipped\n");
  return d;
});

row("ghost named in assert-bundle", 1, /PHANTOM/, () => {
  const d = fixture({ bundle: GOOD_BUNDLE, assert: `${GOOD_ASSERT} hooks/ghost.bundle.mjs` });
  buildArtefact(d);
  return d;
});

row("declared name resolves outside root", 2, /resolves outside/, () => {
  const d = fixture({ bundle: GOOD_BUNDLE, assert: `${GOOD_ASSERT} ../shared/b.bundle.mjs` });
  buildArtefact(d);
  return d;
});

// A rule, not a per-row expectation: **exit 2 must never be worded as a verdict.** The peer's row 09 carried
// `notMatch: /UNCOVERED/` written against an old symptom, and the correct behaviour kept failing it — which is
// how it discovered that a `2` may state what the instrument could not do and must not state what the tree is.
// Mine said `FAIL cannot audit …` at all eight exit-2 sites, so the code said "cannot answer" while the words
// said "the tree is bad". Derived here rather than listed per row, so a future exit-2 site inherits the rule.
// Two properties, not one. (a) The line the reader ends on must be the CANNOT AUDIT line — the summary is a
// conclusion and a conclusion printed after "I could not finish" is the defect. (b) The word `OK` must never
// appear: it belongs to the summary alone, and `VERIFIED` now names the per-artefact pass.
// Per-artefact `FAIL`/`VERIFIED` lines are deliberately NOT forbidden — each is a true statement about one
// file that is unaffected by a later exit 2 (see the mixed row), which is why the rule targets the summary.
const VERDICT = /assert-bundle-fresh: OK/;

row("stale artefact AND a declared name outside root", 2, /resolves outside .*already failed/, () => {
  const d = fixture({ bundle: GOOD_BUNDLE, assert: `${GOOD_ASSERT} ../shared/b.bundle.mjs` });
  buildArtefact(d);
  writeFileSync(join(d, "hooks", "a.bundle.mjs"), "// shipped bytes no build produces\n");
  return d;
});

let bad = 0;
for (const { label, expectedCode, expectedMatch, make } of rows) {
  let dir;
  try {
    dir = make();
  } catch (error) {
    console.log(`  FAIL  ${label} — fixture itself failed: ${String(error).slice(0, 100)}`);
    bad += 1;
    continue;
  }
  const { code, stdout, stderr } = gateRun(dir);
  const out = `${stdout}${stderr}`; // message assertions only; the structure below is checked per stream
  const codeOk = code === expectedCode;
  const matchOk = expectedMatch.test(out);
  const lastStderr = stderr.split("\n").filter(Boolean).pop() ?? "";
  // Named separately: the two ways an exit-2 report can lie are different defects, and a row that fails
  // should say which one it saw rather than "a verdict" while pointing at a line that is not the culprit.
  const spokeOk = expectedCode === 2 && VERDICT.test(stdout);
  const endsOnVerdict = expectedCode === 2 && !lastStderr.startsWith("assert-bundle-fresh: CANNOT AUDIT");
  // (c) The separator must be unspellable by the content and present exactly once. The peer measured why: its
  // `A - B - C` line had three hyphens because the JSON error message itself carried them, so reason and remedy
  // could not be told apart. A separator is a claim that content cannot contain it, and that claim needs a test.
  const badSeparator =
    expectedCode === 2 && (lastStderr.match(/; remedy: /g) ?? []).length !== 1;
  const verdict = spokeOk || endsOnVerdict || badSeparator;
  if (codeOk && matchOk && !verdict) {
    console.log(`  ok    ${label}  (exit ${code})${expectedCode === 2 ? "  no verdict" : ""}`);
  } else {
    bad += 1;
    const why = !codeOk
      ? `exit ${code}, expected ${expectedCode}`
      : !matchOk
        ? `exit ${code} but no /${expectedMatch.source}/`
        : spokeOk
          ? `exit 2 but the word OK appeared: ${out.split("\n").find((l) => VERDICT.test(l)).trim().slice(0, 100)}`
          : endsOnVerdict
            ? `exit 2 but stderr ended on: ${(lastStderr || "<empty>").trim().slice(0, 110)}`
            : `exit 2 but the line has ${(lastStderr.match(/; remedy: /g) ?? []).length} "; remedy: " separators: ${lastStderr.trim().slice(0, 100)}`;
    console.log(`  FAIL  ${label} — ${why}`);
    if (matchOk) console.log(`        ${out.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 160)}`);
  }
}

console.log(`assert-bundle-fresh selftest: ${rows.length - bad}/${rows.length} rows behave`);
process.exit(bad === 0 ? 0 : 1);
