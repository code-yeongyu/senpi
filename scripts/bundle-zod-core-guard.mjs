import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// senpi#6497: the MCP client parses remote-server JSON-RPC with schemas built on whichever zod core the MCP SDK's
// `zod/v4` import reached. A hoisted zod 3.25.x answers it with a 4.0.0 core, so every emitted file is scanned for
// the core banner the minified zod carries, and anything older than 4.6.6 must be an expected, pinned exposure.
// The scan refuses to pass vacuously: a missing bundle or one with no .js file is a failed scan, not a clean one.

/** The banner zod 4.x's core emits, as esbuild and bun minify it. */
const ZOD_CORE_BANNER = /major:\s*4,\s*minor:\s*(\d+),\s*patch:\s*(\d+)/g;
/**
 * The enum zod 3.x's classic build assigns (`ZodFirstPartyTypeKind.ZodEffects = "ZodEffects"`); minifiers keep the
 * string, so it survives in bun and esbuild output. zod 4 has no ZodEffects (it uses ZodPipe/ZodTransform) and 3.x
 * carries no version banner, so a copy is reported as "3.x". Verified against zod 3.25.76 built by both.
 */
const ZOD_V3_MARKER = /ZodEffects\s*=\s*["']ZodEffects["']/g;
const MINIMUM = { minor: 6, patch: 6 };

/**
 * Every zod core older than 4.6.6 the bundle may carry, pinned by (file, version, occurrence count): the minified zod
 * `@anthropic-ai/claude-agent-sdk` embeds inside its prebuilt sdk.mjs. It is not an import, so no resolver reaches it,
 * and it parses the local Claude Code subprocess's output, not a remote server's. It appears once in the SDK's own
 * split chunk and once in the session worker, whose graph is bundled whole (splitting off). A copy anywhere else, a
 * second copy in one of these files or a different version is a new exposure; a copy that disappears means the SDK
 * moved on and its row here is retired.
 */
export const EXPECTED_STALE_ZOD_CORES = [
	{ file: /^chunks\/sdk-[^/]+\.js$/, version: "4.6.2", count: 1 },
	{ file: "chunks/session-worker.js", version: "4.6.2", count: 1 },
];

function isStale({ major, minor, patch }) {
	if (major === 3) return true;
	return minor < MINIMUM.minor || (minor === MINIMUM.minor && patch < MINIMUM.patch);
}

function fileMatches(pattern, file) {
	return typeof pattern === "string" ? pattern === file : pattern.test(file);
}

/** Every zod 4.x core banner in the bundle's emitted .js files, in file order. Throws on a missing or empty bundle. */
export function scanZodCores(bundleDir) {
	let names;
	try {
		names = readdirSync(bundleDir, { recursive: true, encoding: "utf8" });
	} catch (error) {
		throw new Error(`cannot scan the bundle for zod cores: ${bundleDir} is unreadable (${error.code ?? error.message})`);
	}
	const files = names
		.filter((name) => name.endsWith(".js"))
		.map((name) => name.replaceAll("\\", "/"))
		.sort((left, right) => left.localeCompare(right));
	if (files.length === 0) throw new Error(`cannot scan the bundle for zod cores: no emitted .js file under ${bundleDir}`);
	const found = [];
	for (const file of files) found.push(...scanText(readFileSync(join(bundleDir, file), "utf8"), file));
	return found;
}

/** Every zod 4.x core banner and zod 3.x copy marker in `text`, tagged with `file`. */
function scanText(text, file) {
	const found = [];
	for (const match of text.matchAll(ZOD_CORE_BANNER)) {
		const minor = Number(match[1]);
		const patch = Number(match[2]);
		found.push({ file, version: `4.${minor}.${patch}`, major: 4, minor, patch });
	}
	for (const _ of text.matchAll(ZOD_V3_MARKER)) found.push({ file, version: "3.x", major: 3, minor: 0, patch: 0 });
	return found;
}

/**
 * Scans compiled executables (`bun build --compile` embeds the bundled JS as text, so the same banners are present).
 * The embedded files' names are lost, so the pinned SDK copies are matched by version alone: each `EXPECTED_STALE_ZOD_CORES`
 * version may appear at most as often as its rows' counts sum to, across all binaries of one build; anything else
 * older than 4.6.6, and any zod 3.x copy, fails. Returns the stale occurrences it checked.
 */
export function assertBinaryZodCores(binaries, expected = EXPECTED_STALE_ZOD_CORES) {
	if (binaries.length === 0) throw new Error("cannot scan the binaries for zod cores: no binary to scan");
	const problems = [];
	const checked = [];
	for (const binary of binaries) {
		let text;
		try {
			text = readFileSync(binary, "latin1");
		} catch (error) {
			throw new Error(`cannot scan the binary for zod cores: ${binary} is unreadable (${error.code ?? error.message})`);
		}
		const stale = scanText(text, binary).filter(isStale);
		checked.push(...stale);
		const outside = [];
		for (const version of new Set(stale.map((entry) => entry.version))) {
			const entries = stale.filter((entry) => entry.version === version);
			const allowed = expected.filter((row) => row.version === version).reduce((sum, row) => sum + row.count, 0);
			if (allowed === 0) outside.push(...entries);
			else if (entries.length > allowed) problems.push(`${binary}: at most ${allowed} zod ${version} core(s), found ${entries.length}`);
		}
		if (outside.length > 0) {
			problems.push(`zod cores older than 4.${MINIMUM.minor}.${MINIMUM.patch} outside the pinned exposures: ${outside.map((entry) => `${entry.file} ${entry.version}`).join(", ")}`);
		}
	}
	if (problems.length > 0) throw new Error(`stale zod cores in compiled binaries:\n  ${problems.join("\n  ")}`);
	return checked;
}

/**
 * Fails unless the stale zod cores in `bundleDir` are exactly `expected`: each row claims the occurrences whose file
 * matches its pattern and whose version equals its version, and must claim exactly `count` of them; an occurrence no
 * row claims fails. Returns the stale occurrences it checked.
 */
export function assertBundleZodCores(bundleDir, expected = EXPECTED_STALE_ZOD_CORES) {
	const stale = scanZodCores(bundleDir).filter(isStale);
	const unclaimed = new Set(stale);
	const problems = [];
	for (const row of expected) {
		const claimed = stale.filter((entry) => entry.version === row.version && fileMatches(row.file, entry.file));
		for (const entry of claimed) unclaimed.delete(entry);
		if (claimed.length === row.count) continue;
		const where = claimed.length > 0 ? ` (${claimed.map((entry) => entry.file).join(", ")})` : "";
		const retire = claimed.length === 0 ? "; retire the row if the embedded copy moved past 4.6.5" : "";
		problems.push(`expected ${row.count} zod ${row.version} core(s) in ${String(row.file)}, found ${claimed.length}${where}${retire}`);
	}
	if (unclaimed.size > 0) {
		const list = Array.from(unclaimed, (entry) => `${entry.file} ${entry.version}`).join(", ");
		problems.push(`zod cores older than 4.${MINIMUM.minor}.${MINIMUM.patch} outside the pinned exposures: ${list}`);
	}
	if (problems.length > 0) throw new Error(`stale zod cores in ${bundleDir}:\n  ${problems.join("\n  ")}`);
	return stale;
}
