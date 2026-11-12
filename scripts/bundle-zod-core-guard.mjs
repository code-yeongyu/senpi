import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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
const SCRIPT_EXTENSIONS = /\.(?:m|c)?js$/;

const SDK_NAME = "@anthropic-ai/claude-agent-sdk";
const REPO_ROOT = join(import.meta.dirname, "..");

/** The vendored Claude agent SDK version the allowance below was reviewed on; any other version voids it. */
export const PINNED_CLAUDE_AGENT_SDK_VERSION = "0.3.321";

/**
 * The only stale zod allowed is what the vendored `@anthropic-ai/claude-agent-sdk` embeds in its own published files: a
 * minified zod 4.6.2 core and zod's unpatched `zod/v3` classic layer. It is not an import, so no resolver reaches it, and it
 * parses the local Claude Code subprocess's output, not a remote server's. The allowance is keyed on:
 *  - the exact SDK version (`sdkVersion`; the installed package and every lockfile entry must equal it);
 *  - the sha256 of every SDK file that carries a stale copy (`sources`, hashed as published, before any bundler touches
 *    them), and the stale copies each carries. An SDK file carrying a stale copy that is not listed here fails;
 *  - where the copies may land: `reachedSource` is the SDK entry the CLI imports. In the bundle, its copies may sit only in
 *    the outputs whose esbuild metafile inputs include that file (`sdkSourceOutputs`), each output holds exactly its
 *    copies, and those outputs must be exactly one per `bundle` name (pattern): the build also emits an unrelated
 *    `chunks/sdk-*.js`, so a name pattern alone cannot place them (senpi#6514 review). Each compiled binary holds
 *    exactly its copies too. Only placement, count and version are checked in the output:
 *    the bundler renames, tree-shakes and (for `bun build --compile`) folds `process.platform` per target, so output
 *    bytes are not a stable identity, while the source hash above is.
 * To re-review after an SDK bump: install it, run the scan, read the new source sha256 values from the failure, review the
 * new SDK's embedded zod, then update the version, hashes and stale lists here.
 */
export const STALE_ZOD_ALLOWANCE = {
	sdkVersion: PINNED_CLAUDE_AGENT_SDK_VERSION,
	sources: [
		{ path: "sdk.mjs", sha256: "20524b5de1d5e69f4b98005994e0970f0426c99ec55e9b9dae1af1f270d86ab7", stale: ["4.6.2", "3.x"] },
		{ path: "bridge.mjs", sha256: "5bf1b9f96a64df0c26f89db6f1f8545287bc0353caa2016e2f4e8718b764d2c3", stale: ["4.6.2"] },
		{ path: "browser-sdk.js", sha256: "ff345a16af6640bdec252b3eb18b5a4cfc312d095116b0a49c1f1ddfe12bd775", stale: ["4.6.2", "3.x"] },
	],
	reachedSource: "sdk.mjs",
	bundle: [/^chunks\/sdk-[^/]+\.js$/, "chunks/session-worker.js"],
};

function isStale({ major, minor, patch }) {
	if (major === 3) return true;
	return minor < MINIMUM.minor || (minor === MINIMUM.minor && patch < MINIMUM.patch);
}

function fileMatches(pattern, file) {
	return typeof pattern === "string" ? pattern === file : pattern.test(file);
}

/** Cores in ascending version order, then zod/v3 layers: a stable form for comparing and printing stale lists. */
function canonical(versions) {
	const rank = (version) => (version === "3.x" ? [1, 0, 0] : [0, ...version.split(".").slice(1).map(Number)]);
	return [...versions].sort((left, right) => {
		const [a, b] = [rank(left), rank(right)];
		return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
	});
}
const listOf = (versions) => `[${canonical(versions).join(", ")}]`;

/** Every zod 4.x core banner and zod 3.x copy marker in `text`, tagged with `file`. */
function scanText(text, file) {
	const found = [];
	for (const match of text.matchAll(ZOD_CORE_BANNER)) {
		const minor = Number(match[1]);
		const patch = Number(match[2]);
		found.push({ file, version: `4.${minor}.${patch}`, major: 4, minor, patch, kind: "core" });
	}
	for (const _ of text.matchAll(ZOD_V3_MARKER)) found.push({ file, version: "3.x", major: 3, minor: 0, patch: 0, kind: "zod/v3 layer" });
	return found;
}

function scriptFilesUnder(dir, skip = () => false) {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map((name) => name.replaceAll("\\", "/"))
		.filter((name) => SCRIPT_EXTENSIONS.test(name) && !skip(name))
		.sort((left, right) => left.localeCompare(right));
}

/** Every zod 4.x core banner in the bundle's emitted .js files, in file order. Throws on a missing or empty bundle. */
export function scanZodCores(bundleDir) {
	let files;
	try {
		files = scriptFilesUnder(bundleDir, (name) => !name.endsWith(".js"));
	} catch (error) {
		throw new Error(`cannot scan the bundle for zod cores: ${bundleDir} is unreadable (${error.code ?? error.message})`);
	}
	if (files.length === 0) throw new Error(`cannot scan the bundle for zod cores: no emitted .js file under ${bundleDir}`);
	return files.flatMap((file) => scanText(readFileSync(join(bundleDir, file), "utf8"), file));
}

/** The installed and locked versions of the vendored Claude agent SDK, and its package directory. */
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
	return { installed, locked, dir };
}

const unreviewed = (version, how, pinned) =>
	`${SDK_NAME} ${version} is ${how} but the stale zod allowance in scripts/bundle-zod-core-guard.mjs is pinned to ${pinned}: the new SDK's embedded zod copies are unreviewed; re-review them and update the pin and hashes`;

/** Fails unless the installed SDK and every lockfile entry are exactly the version `allowance` was reviewed on. */
function assertSdkPinned(allowance, sdk) {
	const pinned = allowance.sdkVersion;
	if (sdk.installed === undefined) {
		throw new Error(`cannot read the installed ${SDK_NAME} version, so the stale zod allowance (pinned to ${pinned}) cannot be applied`);
	}
	if (sdk.installed !== pinned) throw new Error(unreviewed(sdk.installed, "installed", pinned));
	if (sdk.locked.length === 0) throw new Error(`no lockfile entry for ${SDK_NAME}, so the stale zod allowance (pinned to ${pinned}) cannot be applied`);
	for (const version of sdk.locked) {
		if (version !== pinned) throw new Error(unreviewed(version, "locked", pinned));
	}
}

/**
 * Fails unless every installed SDK file carrying a stale zod copy is a pinned source, each pinned source has its pinned
 * sha256, and each carries exactly its pinned stale copies. Returns the sources with their hashes and stale copies.
 */
export function assertClaudeAgentSdkSources(allowance, sdk) {
	const problems = [];
	const pinned = new Set(allowance.sources.map((source) => source.path));
	for (const file of scriptFilesUnder(sdk.dir, (name) => name.split("/").includes("node_modules"))) {
		if (pinned.has(file)) continue;
		const stale = scanText(readFileSync(join(sdk.dir, file), "utf8"), file).filter(isStale);
		if (stale.length > 0) problems.push(`${file} carries stale zod ${listOf(stale.map((entry) => entry.version))} but is not a pinned source`);
	}
	const sources = [];
	for (const source of allowance.sources) {
		let bytes;
		try {
			bytes = readFileSync(join(sdk.dir, source.path));
		} catch (error) {
			problems.push(`${source.path}: pinned source is unreadable (${error.code ?? error.message})`);
			continue;
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (sha256 !== source.sha256) {
			problems.push(`${source.path}: sha256:${sha256}, pinned sha256:${source.sha256} (${SDK_NAME} ${allowance.sdkVersion} as reviewed has different bytes)`);
			continue;
		}
		const stale = scanText(bytes.toString("utf8"), source.path).filter(isStale).map((entry) => entry.version);
		if (listOf(stale) !== listOf(source.stale)) {
			problems.push(`${source.path} carries stale zod ${listOf(stale)}, pinned ${listOf(source.stale)}`);
			continue;
		}
		sources.push({ path: source.path, sha256, stale: canonical(stale) });
	}
	if (problems.length > 0) {
		throw new Error(`${SDK_NAME} ${allowance.sdkVersion} at ${sdk.dir} does not match the reviewed stale zod sources:\n  ${problems.join("\n  ")}`);
	}
	return sources;
}

/** Version pin, then source hashes; returns the stale copies each allowed output location must hold. */
function verifiedSdk(allowance, sdk) {
	assertSdkPinned(allowance, sdk);
	const sources = assertClaudeAgentSdkSources(allowance, sdk);
	const reached = sources.find((source) => source.path === allowance.reachedSource);
	if (reached === undefined) throw new Error(`the reached SDK source ${allowance.reachedSource} is not a pinned source`);
	return { sources, expected: reached.stale };
}

/**
 * The bundle outputs (relative to `bundleDir`, forward slashes) whose esbuild metafile inputs include the vendored SDK's
 * `reachedSource`: the only files its stale copies may land in. Metafile paths are relative to `absWorkingDir`.
 */
export function sdkSourceOutputs(metafiles, bundleDir, allowance = STALE_ZOD_ALLOWANCE, absWorkingDir = REPO_ROOT) {
	const source = `node_modules/${SDK_NAME}/${allowance.reachedSource}`;
	const outputs = new Set();
	for (const metafile of metafiles) {
		for (const [outputPath, output] of Object.entries(metafile.outputs)) {
			if (!Object.keys(output.inputs).some((input) => input.replaceAll("\\", "/").endsWith(source))) continue;
			outputs.add(relative(bundleDir, resolve(absWorkingDir, outputPath)).replaceAll("\\", "/"));
		}
	}
	return [...outputs].sort((left, right) => left.localeCompare(right));
}

/** Problems unless each allowed `bundle` name (pattern) matches exactly one SDK output and every SDK output matches one. */
function checkPlacement(allowance, sdkOutputs) {
	const problems = [];
	for (const location of allowance.bundle) {
		const matched = sdkOutputs.filter((file) => fileMatches(location, file));
		if (matched.length !== 1) {
			problems.push(`${String(location)}: expected exactly one output built from ${SDK_NAME}/${allowance.reachedSource}, found [${matched.join(", ")}]`);
		}
	}
	for (const file of sdkOutputs) {
		if (!allowance.bundle.some((location) => fileMatches(location, file))) {
			problems.push(`${file} is built from ${SDK_NAME}/${allowance.reachedSource} but is not an allowed location`);
		}
	}
	return problems;
}

/** Problems when a location's stale copies differ from `expected` (exact versions and counts; none is a failure too). */
function checkLocation(name, entries, expected, copies) {
	const found = entries.map((entry) => entry.version);
	if (listOf(found) === listOf(expected)) {
		copies.push(...entries);
		return [];
	}
	const retire = found.length === 0 ? `; retire the allowance if ${SDK_NAME} no longer reaches this output` : "";
	const files = [...new Set(entries.map((entry) => entry.file))].filter((file) => file !== name);
	if (files.length > 0) name = `${name} (${files.join(", ")})`;
	return [`${name}: expected stale zod ${listOf(expected)}, found ${listOf(found)}${retire}`];
}

/** Allowed copies by file, then in canonical version order. */
function sortCopies(copies) {
	const order = (version) => canonical(copies.map((entry) => entry.version)).indexOf(version);
	return copies.sort((left, right) => left.file.localeCompare(right.file) || order(left.version) - order(right.version));
}

/** Report lines for a passing scan: the SDK version and source hashes, then every allowed stale copy. */
export function describeStaleZodAllowances({ sdkVersion, sources, copies }) {
	const label = (version) => (version === "3.x" ? "zod/v3 layer" : `zod ${version} core`);
	return [
		...sources.map((source) => `pinned stale zod source: ${SDK_NAME} ${sdkVersion} ${source.path} sha256:${source.sha256} (${source.stale.map(label).join(", ")})`),
		...copies.map((entry) => `allowed stale zod copy: ${SDK_NAME} ${sdkVersion} ${entry.file} ${label(entry.version)}`),
	];
}

/**
 * Scans compiled executables (`bun build --compile` embeds the bundled JS as text, so the same banners are present).
 * Each binary must hold exactly the reached SDK source's stale copies and at least one current (4.6.6 or newer) core.
 */
export function assertBinaryZodCores(binaries, allowance = STALE_ZOD_ALLOWANCE, sdk = readClaudeAgentSdkVersions()) {
	if (binaries.length === 0) throw new Error("cannot scan the binaries for zod cores: no binary to scan");
	const { sources, expected } = verifiedSdk(allowance, sdk);
	const problems = [];
	const copies = [];
	for (const binary of binaries) {
		let text;
		try {
			text = readFileSync(binary, "latin1");
		} catch (error) {
			throw new Error(`cannot scan the binary for zod cores: ${binary} is unreadable (${error.code ?? error.message})`);
		}
		const cores = scanText(text, binary);
		if (!cores.some((entry) => !isStale(entry))) {
			problems.push(`${binary}: no current zod core (4.${MINIMUM.minor}.${MINIMUM.patch} or newer) found; a binary that must embed one scanned nothing`);
		}
		problems.push(...checkLocation(binary, cores.filter(isStale), expected, copies));
	}
	if (problems.length > 0) {
		throw new Error(`stale zod cores in compiled binaries (allowance: ${SDK_NAME} ${allowance.sdkVersion} only):\n  ${problems.join("\n  ")}`);
	}
	return { sdkVersion: allowance.sdkVersion, sources, copies: sortCopies(copies) };
}

/**
 * Fails unless every stale zod copy in `bundleDir` sits in an exact SDK output (`sdkOutputs`, from `sdkSourceOutputs`), each
 * of those files holds exactly the reached SDK source's stale copies, and the outputs are exactly one per allowed `bundle`
 * name, under the pinned SDK version and source hashes.
 */
export function assertBundleZodCores(bundleDir, sdkOutputs, allowance = STALE_ZOD_ALLOWANCE, sdk = readClaudeAgentSdkVersions()) {
	const { sources, expected } = verifiedSdk(allowance, sdk);
	const stale = scanZodCores(bundleDir).filter(isStale);
	const problems = checkPlacement(allowance, sdkOutputs);
	const copies = [];
	for (const file of sdkOutputs) {
		problems.push(...checkLocation(file, stale.filter((entry) => entry.file === file), expected, copies));
	}
	const outside = stale.filter((entry) => !sdkOutputs.includes(entry.file));
	if (outside.length > 0) {
		problems.push(`zod cores older than 4.${MINIMUM.minor}.${MINIMUM.patch} outside the allowed files: ${outside.map((entry) => `${entry.file} ${entry.version}`).join(", ")}`);
	}
	if (problems.length > 0) {
		throw new Error(`stale zod cores in ${bundleDir} (allowance: ${SDK_NAME} ${allowance.sdkVersion} only):\n  ${problems.join("\n  ")}`);
	}
	return { sdkVersion: allowance.sdkVersion, sources, copies: sortCopies(copies) };
}
