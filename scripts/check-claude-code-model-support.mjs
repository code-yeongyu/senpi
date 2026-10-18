#!/usr/bin/env node
// Catalog-tier companion of test/suite/regressions/8700-claude-code-promoted-model-support.test.ts
// (omo#8700). The regression test blocks on the Claude models senpi PROMOTES; this script reports
// every Anthropic catalog id the pinned Claude Code binary does not embed, and with
// --sdk-currency whether the pin trails the newest published @anthropic-ai/claude-agent-sdk.
//
//   node scripts/check-claude-code-model-support.mjs                 # report catalog gaps, exit 0
//   node scripts/check-claude-code-model-support.mjs --strict        # exit 1 on any catalog gap
//   node scripts/check-claude-code-model-support.mjs --sdk-currency  # exit 1 when the pin trails npm latest (network)

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const codingAgent = join(repoRoot, "packages", "coding-agent");
const args = new Set(process.argv.slice(2));

function pinnedSdkVersion() {
	const manifest = JSON.parse(readFileSync(join(codingAgent, "package.json"), "utf8"));
	return manifest.dependencies?.["@anthropic-ai/claude-agent-sdk"];
}

function bundledBinary() {
	const require = createRequire(join(codingAgent, "package.json"));
	const ext = process.platform === "win32" ? ".exe" : "";
	const names =
		process.platform === "linux"
			? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
			: [`${process.platform}-${process.arch}`];
	for (const name of names) {
		try {
			const path = require.resolve(`@anthropic-ai/claude-agent-sdk-${name}/claude${ext}`);
			if (existsSync(path)) return path;
		} catch {
			// not installed for this libc/platform; try the next spelling
		}
	}
	return undefined;
}

const ID_BYTE = /[A-Za-z0-9._-]/;
const isIdByte = (byte) => byte !== undefined && ID_BYTE.test(String.fromCharCode(byte));

function containsToken(chunk, needle) {
	for (let at = chunk.indexOf(needle); at !== -1; at = chunk.indexOf(needle, at + 1)) {
		if (!isIdByte(chunk[at - 1]) && !isIdByte(chunk[at + needle.length])) return true;
	}
	return false;
}

function embeddedTokens(path, tokens) {
	const chunkBytes = 8 * 1024 * 1024;
	const needles = tokens.map((token) => [token, Buffer.from(token)]);
	const overlap = Math.max(0, ...needles.map(([, bytes]) => bytes.length)) + 1;
	const buffer = Buffer.alloc(chunkBytes + overlap);
	const found = new Set();
	const fd = openSync(path, "r");
	try {
		let carried = 0;
		let position = 0;
		for (;;) {
			const read = readSync(fd, buffer, carried, chunkBytes, position);
			if (read === 0) break;
			position += read;
			const chunk = buffer.subarray(0, carried + read);
			for (const [token, bytes] of needles) if (!found.has(token) && containsToken(chunk, bytes)) found.add(token);
			carried = Math.min(overlap, chunk.length);
			chunk.copy(buffer, 0, chunk.length - carried);
		}
	} finally {
		closeSync(fd);
	}
	return found;
}

function checkCatalog() {
	const catalog = JSON.parse(readFileSync(join(repoRoot, "packages", "ai", "src", "providers", "data", "anthropic.json"), "utf8"));
	const ids = Object.keys(catalog["anthropic-messages"] ?? {}).filter((id) => id.startsWith("claude-"));
	const binary = bundledBinary();
	if (!binary) {
		console.error("check-claude-code-model-support: no bundled Claude Code binary; reinstall without --omit=optional");
		return 1;
	}
	const found = embeddedTokens(binary, ["claude-sonnet-4-5", ...ids]);
	if (!found.has("claude-sonnet-4-5")) {
		console.error(`check-claude-code-model-support: cannot read ${binary} (control id missing); fix the scanner`);
		return 1;
	}
	const missing = ids.filter((id) => !found.has(id));
	const sdk = pinnedSdkVersion();
	if (missing.length === 0) {
		console.log(`check-claude-code-model-support: Claude Code of @anthropic-ai/claude-agent-sdk ${sdk} knows all ${ids.length} catalog Claude ids.`);
		return 0;
	}
	console.log(
		`check-claude-code-model-support: Claude Code of @anthropic-ai/claude-agent-sdk ${sdk} does not know ${missing.length} catalog id(s): ${missing.join(", ")}.\n` +
			"anthropic-subscription requests to these ids 400 until the pin is bumped (or the id is not yet in any Claude Code release).",
	);
	return args.has("--strict") ? 1 : 0;
}

function checkSdkCurrency() {
	const pinned = pinnedSdkVersion();
	const latest = execFileSync("npm", ["view", "@anthropic-ai/claude-agent-sdk", "version"], {
		cwd: "/",
		encoding: "utf8",
		shell: process.platform === "win32",
	}).trim();
	if (!/^\d+\.\d+\.\d+$/.test(latest)) {
		console.error(`check-claude-code-model-support: npm returned no version (${JSON.stringify(latest)})`);
		return 1;
	}
	if (pinned === latest) {
		console.log(`check-claude-code-model-support: @anthropic-ai/claude-agent-sdk ${pinned} is the latest published release.`);
		return 0;
	}
	console.error(
		`check-claude-code-model-support: @anthropic-ai/claude-agent-sdk is pinned at ${pinned}, latest published is ${latest}. ` +
			"Bump the pin (and its 8 platform optionalDependencies) so new Claude models are usable on anthropic-subscription.",
	);
	return 1;
}

process.exitCode = args.has("--sdk-currency") ? checkSdkCurrency() : checkCatalog();
