import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// senpi#6497: the MCP client parses remote-server JSON-RPC with schemas built on whichever zod core the MCP SDK's
// `zod/v4` import reached. A hoisted zod 3.25.x answers it with a 4.0.0 core, so every emitted file is scanned for
// the core banner the minified zod carries, and anything older than 4.6.6 must be an expected, pinned exposure.
// The scan refuses to pass vacuously: a missing bundle or one with no .js file is a failed scan, not a clean one.

/** The banner zod 4.x's core emits, as esbuild and bun minify it. */
const ZOD_CORE_BANNER = /major:\s*4,\s*minor:\s*(\d+),\s*patch:\s*(\d+)/g;
/**
 * The emoji pattern string of an UNPATCHED zod 3.x classic build: `^(\p{Extended_Pictographic}|\p{Emoji_Component})+$`.
 * `ZodEffects` is not usable: zod 4.x ships the same classic build as its `zod/v3` compatibility layer, which the
 * MCP SDK and our MCP schemas import. That layer carries the same enum, but zod 4.6.x hardened it, and one of the
 * changes rewrote this pattern to a character class (`^[\p{Extended_Pictographic}\p{Emoji_Component}]+$`).
 * So this alternation form is unique to a real zod 3.x copy. String literals survive minification, so it appears in
 * esbuild and bun output alike (checked against zod 3.25.76 and zod 4.6.7's `zod/v3`, built by both). 3.x carries no
 * version banner, so a copy is reported as "3.x".
 */
const ZOD_V3_MARKER = /Extended_Pictographic\}\|\\{1,2}p\{Emoji_Component\}\)\+\$/g;
const MINIMUM = { minor: 6, patch: 6 };

const SDK_NAME = "@anthropic-ai/claude-agent-sdk";
const REPO_ROOT = join(import.meta.dirname, "..");

/** The vendored Claude agent SDK version the allowance below was measured on; any other version voids it. */
export const PINNED_CLAUDE_AGENT_SDK_VERSION = "0.3.321";

/** How much of the SDK's zod/v3 layer a copy's hash covers, counted from the layer's emoji pattern. */
const V3_WINDOW_BYTES = 32768;

/**
 * Every zod copy older than 4.6.6 that may exist, and nothing else. The only source is the minified zod the vendored
 * `@anthropic-ai/claude-agent-sdk` embeds inside its prebuilt sdk.mjs: a 4.6.2 core plus zod's unpatched `zod/v3` classic
 * layer. It is not an import, so no resolver reaches it, and it parses the local Claude Code subprocess's output, not a
 * remote server's. The allowance is keyed on THREE things at once:
 *  - the exact SDK version (`sdkVersion`; the installed package and every lockfile entry must equal it),
 *  - where the copy lives (the SDK chunk and the session worker in the npm bundle, whose graph is bundled whole with
 *    splitting off; the names are lost in a compiled binary, where each copy appears once),
 *  - the sha256 of the copy's exact bytes. A "4.6.2 core" copy is the text from its `{major:4,minor:6,patch:2}` banner up
 *    to the zod/v3 layer's emoji pattern; a "zod/v3 layer" copy is the 32 KiB that start at that pattern. The bundler
 *    rewrites the SDK per output (tree-shaking, renames, minification), so each output form carries its own hash.
 * A different SDK, a changed byte in a copy, a copy in another file, or another count fails; a copy that disappears
 * means the SDK moved on and its row is retired. To re-measure after an SDK bump: build, run
 * `node scripts/assert-binary-zod-cores.mjs` after a compile, read each reported sha256, and review the new SDK's zod.
 */
export const STALE_ZOD_ALLOWANCE = {
	sdkVersion: PINNED_CLAUDE_AGENT_SDK_VERSION,
	bundle: [
		{ file: /^chunks\/sdk-[^/]+\.js$/, version: "4.6.2", sha256: "b39755b19bac223d186389643ca41fe0585922a3823d015359c54548ba495ae0" },
		{ file: "chunks/session-worker.js", version: "4.6.2", sha256: "1c791e63090499a92e22b3d8fa83ad463e42a8ed61975b580238d52760e1fba9" },
		{ file: /^chunks\/sdk-[^/]+\.js$/, version: "3.x", sha256: "cd1886d6de269fb902a9835e3b80a319d5b105a3b4936941df54e0cf392908fe" },
		{ file: "chunks/session-worker.js", version: "3.x", sha256: "4d1ed7396a99f17cf3acba1bcf7c1fe1426d607f2dca1994aa20a9ec7aea043d" },
	],
	binary: [
		{ version: "4.6.2", sha256: "41aeaf57f1952159e78f66156104e142c270169ec032c695d93da9ed5bc98db1" },
		{ version: "3.x", sha256: "bc794b36778d2fbfde4bcb185800f3130b899c7736b4cafae9e5791ba2f0bf9a" },
	],
};

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
	for (const file of files) found.push(...scanText(readFileSync(join(bundleDir, file), "utf8"), file, "utf8"));
	return found;
}

function sha256Of(text, encoding, start, end) {
	return createHash("sha256").update(text.slice(start, end), encoding).digest("hex");
}

/**
 * Every zod 4.x core banner and zod 3.x copy marker in `text`, tagged with `file` and with the sha256 of its bytes (see
 * STALE_ZOD_ALLOWANCE for which bytes). `encoding` is how `text` was decoded, so the hash covers the file's raw bytes.
 */
function scanText(text, file, encoding) {
	const found = [];
	const layers = Array.from(text.matchAll(ZOD_V3_MARKER), (match) => match.index);
	for (const match of text.matchAll(ZOD_CORE_BANNER)) {
		const minor = Number(match[1]);
		const patch = Number(match[2]);
		const layer = layers.find((index) => index > match.index);
		const sha256 = layer === undefined ? "no-zod-v3-layer-follows" : sha256Of(text, encoding, match.index, layer);
		found.push({ file, version: `4.${minor}.${patch}`, major: 4, minor, patch, kind: "core", sha256 });
	}
	for (const index of layers) {
		found.push({ file, version: "3.x", major: 3, minor: 0, patch: 0, kind: "zod/v3 layer", sha256: sha256Of(text, encoding, index, index + V3_WINDOW_BYTES) });
	}
	return found;
}

/** The installed and locked versions of the vendored Claude agent SDK, read from the resolved package and every lockfile. */
export function readClaudeAgentSdkVersions(root = REPO_ROOT) {
	const packageDirs = [join(root, "packages/coding-agent/node_modules", SDK_NAME), join(root, "node_modules", SDK_NAME)];
	const dir = packageDirs.find((candidate) => existsSync(join(candidate, "package.json")));
	const installed = dir === undefined ? undefined : JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
	const locked = [];
	const bunLock = join(root, "bun.lock");
	if (existsSync(bunLock)) {
		for (const match of readFileSync(bunLock, "utf8").matchAll(/"@anthropic-ai\/claude-agent-sdk@([^"]+)"/g)) locked.push(match[1]);
	}
	const packageLock = join(root, "package-lock.json");
	if (existsSync(packageLock)) {
		const packages = JSON.parse(readFileSync(packageLock, "utf8")).packages ?? {};
		for (const [key, entry] of Object.entries(packages)) {
			if (key === `node_modules/${SDK_NAME}` || key.endsWith(`/node_modules/${SDK_NAME}`)) locked.push(entry.version);
		}
	}
	return { installed, locked, sdkMjs: dir === undefined ? undefined : join(dir, "sdk.mjs") };
}

/** Fails unless the installed SDK and every lockfile entry are exactly the version `allowance` was measured on. */
function assertSdkPinned(allowance, sdk) {
	const pinned = allowance.sdkVersion;
	if (sdk.installed === undefined) {
		throw new Error(`cannot read the installed ${SDK_NAME} version, so the stale zod allowance (pinned to ${pinned}) cannot be applied`);
	}
	if (sdk.installed !== pinned) {
		throw new Error(`${SDK_NAME} ${sdk.installed} is installed but the stale zod allowance in scripts/bundle-zod-core-guard.mjs is pinned to ${pinned}: the new SDK's embedded zod copies are unreviewed; re-measure them and update the pin and hashes`);
	}
	if (sdk.locked.length === 0) throw new Error(`no lockfile entry for ${SDK_NAME}, so the stale zod allowance (pinned to ${pinned}) cannot be applied`);
	for (const version of sdk.locked) {
		if (version !== pinned) {
			throw new Error(`${SDK_NAME} ${version} is locked but the stale zod allowance in scripts/bundle-zod-core-guard.mjs is pinned to ${pinned}: the new SDK's embedded zod copies are unreviewed; re-measure them and update the pin and hashes`);
		}
	}
}

const kindOf = (version) => (version === "3.x" ? "zod/v3 layer" : "core");
const label = (version) => (version === "3.x" ? "zod/v3 layer" : `zod ${version} core`);

/** One line per allowed stale copy a scan passed: SDK version, file, zod version and the hash its bytes matched. */
export function describeStaleZodAllowances(sdkVersion, checked) {
	return checked.map((entry) => `allowed stale zod copy: ${SDK_NAME} ${sdkVersion} ${entry.file} ${entry.version === "3.x" ? "" : `zod ${entry.version} `}${entry.kind} sha256:${entry.sha256}`);
}

/**
 * Compares the stale copies `found` in one scanned unit with `rows` and returns the problems. Each row claims the
 * entries of its version (in a bundle, also its file) and must find exactly one; the one it finds must carry the pinned
 * hash. An entry no row claims is a new exposure. `claimed` collects the matches.
 */
function matchAllowance(found, rows, sdkVersion, claimed) {
	const problems = [];
	const unclaimed = new Set(found);
	for (const row of rows) {
		const inFile = row.file === undefined ? "" : ` in ${String(row.file)}`;
		const candidates = found.filter((entry) => entry.version === row.version && (row.file === undefined || fileMatches(row.file, entry.file)));
		for (const entry of candidates) unclaimed.delete(entry);
		if (candidates.length !== 1) {
			const names = candidates.length > 0 ? ` (${candidates.map((entry) => entry.file).join(", ")})` : "";
			const retire = candidates.length === 0 ? "; retire the row if the embedded copy moved past 4.6.5" : "";
			problems.push(`expected 1 ${label(row.version)}${inFile}, found ${candidates.length}${names}${retire}`);
			continue;
		}
		const [entry] = candidates;
		if (entry.sha256 !== row.sha256) {
			problems.push(`${entry.file}: ${label(row.version)} bytes changed (sha256:${entry.sha256}, pinned sha256:${row.sha256}; ${SDK_NAME} ${sdkVersion} embeds a different copy than the one reviewed)`);
			continue;
		}
		claimed.push(entry);
	}
	if (unclaimed.size > 0) {
		const list = Array.from(unclaimed, (entry) => `${entry.file} ${entry.version} sha256:${entry.sha256}`).join(", ");
		problems.push(`zod cores older than 4.${MINIMUM.minor}.${MINIMUM.patch} outside the pinned exposures: ${list}`);
	}
	return problems;
}

/**
 * Scans compiled executables (`bun build --compile` embeds the bundled JS as text, so the same banners are present).
 * The embedded files' names are lost, so the SDK's pinned copies are matched by zod version and bytes: each
 * `allowance.binary` row must be found exactly once, with its pinned sha256, in each binary; anything else older than
 * 4.6.6, any other zod 3.x copy, and a binary embedding no current (4.6.6 or newer) core at all, fails. The SDK version
 * must be the pinned one first. Returns the allowed stale copies it checked, each with its hash.
 */
export function assertBinaryZodCores(binaries, allowance = STALE_ZOD_ALLOWANCE, sdk = readClaudeAgentSdkVersions()) {
	if (binaries.length === 0) throw new Error("cannot scan the binaries for zod cores: no binary to scan");
	assertSdkPinned(allowance, sdk);
	const problems = [];
	const checked = [];
	for (const binary of binaries) {
		let text;
		try {
			text = readFileSync(binary, "latin1");
		} catch (error) {
			throw new Error(`cannot scan the binary for zod cores: ${binary} is unreadable (${error.code ?? error.message})`);
		}
		const cores = scanText(text, binary, "latin1");
		if (!cores.some((entry) => !isStale(entry))) {
			problems.push(`${binary}: no current zod core (4.${MINIMUM.minor}.${MINIMUM.patch} or newer) found; a binary that must embed one scanned nothing`);
		}
		problems.push(...matchAllowance(cores.filter(isStale), allowance.binary, allowance.sdkVersion, checked));
	}
	checked.sort((left, right) => left.file.localeCompare(right.file));
	if (problems.length > 0) {
		throw new Error(`stale zod cores in compiled binaries (allowance: ${SDK_NAME} ${allowance.sdkVersion} only):\n  ${problems.join("\n  ")}`);
	}
	return checked;
}

/**
 * Fails unless the stale zod copies in `bundleDir` are exactly `allowance.bundle`, under the pinned SDK version: each row
 * claims the occurrences whose file matches its pattern and whose zod version equals its version, must claim exactly one,
 * and that one must carry the row's sha256; an occurrence no row claims fails. Returns the allowed stale copies it
 * checked, each with its hash.
 */
export function assertBundleZodCores(bundleDir, allowance = STALE_ZOD_ALLOWANCE, sdk = readClaudeAgentSdkVersions()) {
	assertSdkPinned(allowance, sdk);
	const stale = scanZodCores(bundleDir).filter(isStale);
	const checked = [];
	const problems = matchAllowance(stale, allowance.bundle, allowance.sdkVersion, checked);
	checked.sort((left, right) => left.file.localeCompare(right.file));
	if (problems.length > 0) {
		throw new Error(`stale zod cores in ${bundleDir} (allowance: ${SDK_NAME} ${allowance.sdkVersion} only):\n  ${problems.join("\n  ")}`);
	}
	return checked;
}
