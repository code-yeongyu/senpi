import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

// Real bundler output for the zod copies the guard has to tell apart (senpi#6497 follow-up), built with the
// settings scripts/build-coding-agent-bundle.mjs uses (bundle, esm, node, minifySyntax, minifyWhitespace).
// zod 3.25.76 is the copy @anthropic-ai/sandbox-runtime pulls in; zod 4.6.7 is the pinned one, whose `zod/v3`
// compatibility layer is zod 3's classic build with the prototype-pollution fixes applied.

const root = join(import.meta.dirname, "..");
const requireFromRoot = createRequire(join(root, "package.json"));

function zodDirFor(from) {
	const entry = createRequire(join(from, "package.json")).resolve("zod/package.json");
	return dirname(entry);
}

function versionOf(zodDir) {
	return JSON.parse(readFileSync(join(zodDir, "package.json"), "utf8")).version;
}

const SOURCES = {
	"zod-3.25.76": { resolveDir: () => dirname(requireFromRoot.resolve("@anthropic-ai/sandbox-runtime/package.json")), want: "3.25.76", entry: "zod" },
	"zod-4.6.7-v3": { resolveDir: () => root, want: "4.6.7", entry: "zod/v3" },
	"zod-4.6.7-v4": { resolveDir: () => root, want: "4.6.7", entry: "zod/v4" },
};

/** The minified bundle of a tiny entry importing the named real zod copy; throws when the installed copy is not the one named. */
export async function realZodOutput(name) {
	const source = SOURCES[name];
	const resolveDir = source.resolveDir();
	const found = versionOf(zodDirFor(resolveDir));
	if (found !== source.want) throw new Error(`${name}: expected zod ${source.want} reachable from ${resolveDir}, found ${found}`);
	const result = await build({
		stdin: { contents: `import { z } from "${source.entry}"; console.log(z.string().transform((s) => s).parse("a"));`, resolveDir, loader: "js" },
		bundle: true,
		format: "esm",
		platform: "node",
		minifySyntax: true,
		minifyWhitespace: true,
		write: false,
		outfile: "out.js",
	});
	return result.outputFiles[0].text;
}
