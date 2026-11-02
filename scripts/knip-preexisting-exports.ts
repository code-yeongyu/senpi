import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Preprocessor } from "knip";
import { parseSync } from "oxc-parser";

// knip has no per-symbol ignore: an `ignoreIssues` entry silences every export of a file, so a new
// unused export there would pass `knip:check`. This preprocessor drops only the unused exports named
// in knip.jsonc `preprocessorOptions.preExistingExports` ({ "<file>": ["<name>", ...] }); every
// other export of those files stays checked. scripts/knip-coverage.test.ts fails when a listed name
// is no longer reported, so the list cannot go stale.
//
// It also drops an unused export S of a declaration file X.d.mts / X.d.ts / X.d.cts when its runtime twin X.mjs /
// X.js / X.cjs sits in the same directory, the twin itself exports S (an ES module export, read with oxc-parser), and
// knip did not report S unused in the twin. Consumers import the twin, so knip credits the use to the twin and reports
// the declaration mirror's S unused; S is dead only when the twin's S is. Every other finding is kept.

const DECLARATION = /\.d\.([cm]?)ts$/;

const twinExports = (twin: string): Set<string> => {
  const parsed = parseSync(twin, readFileSync(twin, "utf8"));
  if (parsed.errors.length > 0) return new Set();
  return new Set(
    parsed.module.staticExports.flatMap((statement) =>
      statement.entries.flatMap((entry) =>
        entry.exportName.kind === "Name" && entry.exportName.name !== null ? [entry.exportName.name] : [],
      ),
    ),
  );
};

// The (record key, symbol) pairs of declaration mirrors whose twin exports the symbol and uses it. Computed from the
// report before anything is dropped, so a twin export dropped as pre-existing still counts as reported unused.
const usedViaTwin = (cwd: string, records: Record<string, Record<string, { symbol: string }>>): Set<string> => {
  const used = new Set<string>();
  for (const [path, symbols] of Object.entries(records)) {
    const match = DECLARATION.exec(path);
    if (match === null) continue;
    const twinKey = `${path.slice(0, match.index)}.${match[1]}js`;
    const twin = resolve(cwd, twinKey);
    if (!existsSync(twin)) continue;
    const exported = twinExports(twin);
    const unusedInTwin = new Set(Object.values(records[twinKey] ?? {}).map((issue) => issue.symbol));
    for (const issue of Object.values(symbols))
      if (exported.has(issue.symbol) && !unusedInTwin.has(issue.symbol)) used.add(`${path}\0${issue.symbol}`);
  }
  return used;
};

const preExisting = (raw: string): Map<string, Set<string>> => {
  const options: unknown = raw === "" ? {} : JSON.parse(raw);
  const table =
    typeof options === "object" && options !== null && "preExistingExports" in options
      ? options.preExistingExports
      : {};
  if (typeof table !== "object" || table === null || Array.isArray(table))
    throw new Error("knip preprocessorOptions.preExistingExports must be an object");
  const allowed = new Map<string, Set<string>>();
  for (const [file, names] of Object.entries(table)) {
    if (!Array.isArray(names) || !names.every((name) => typeof name === "string"))
      throw new Error(
        `knip preprocessorOptions.preExistingExports["${file}"] must be a string list`,
      );
    allowed.set(file, new Set(names));
  }
  return allowed;
};

const preprocess: Preprocessor = (options) => {
  const allowed = preExisting(options.preprocessorOptions);
  const records = options.issues.exports;
  const mirrored = usedViaTwin(options.cwd, records);
  for (const [path, symbols] of Object.entries(records)) {
    const file = (isAbsolute(path) ? relative(options.cwd, path) : path).split(sep).join("/");
    const names = allowed.get(file) ?? new Set<string>();
    // Record keys can carry a namespace prefix ("daemon.CounterError"); the issue's symbol is the name.
    for (const [key, issue] of Object.entries(symbols)) {
      if (!names.has(issue.symbol) && !mirrored.has(`${path}\0${issue.symbol}`)) continue;
      delete symbols[key];
      options.counters.exports -= 1;
    }
    if (Object.keys(symbols).length === 0) delete records[path];
  }
  return options;
};

export default preprocess;
