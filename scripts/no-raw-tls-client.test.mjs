#!/usr/bin/env node
// Guard for the "stay on Bun 1.4.2" decision (senpi#3078, revisit-condition 3).
//
// Bun 1.4.2 carries CVE-2026-48618: its TLS hostname check accepts
// look-alike-dot hosts (U+3002, U+FF0E, U+FF61), fixed in 1.4.3. Staying on
// 1.4.2 is safe only while every shipped outbound TLS path derives its host
// from a parsed URL: new URL() normalizes the look-alike dots, so the
// normalized name is rejected correctly on 1.4.2 as well. This test fails
// CI when shipped production source gains a direct low-level TLS/HTTPS
// client call that is not on the reviewed allowlist below, so the decision
// cannot silently go stale.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const EXCLUDED_SEGMENTS = new Set([
	"test",
	"tests",
	"__tests__",
	"fixtures",
	"__fixtures__",
	"test-support",
	"test-fixtures",
	"references",
	"docs",
]);

// Reviewed allowlist. Each entry pins one exact call: the repo-relative
// file, the detected call's normalized text (whitespace collapsed, exactly
// as the failure message prints it), the expected occurrence count, and a
// one-line reason stating where the host comes from. A reason is only
// valid if the host is "new URL(...).hostname" or a literal. Adding or
// editing an entry is a reviewed act: name the host provenance and
// reference senpi#3078.
const ALLOWLIST = [
	{
		file: "packages/ai/src/api/cursor-agent.ts",
		call: "http2.connect(baseUrl)",
		count: 2,
		reason: "Node-only module (node:http2, header note at :15) unreachable under Bun; baseUrl is the CURSOR_API_URL literal or model.baseUrl config, and Node's http2.connect parses the string authority as a URL before TLS (senpi#3078).",
	},
];

const OFFENDER_GUIDANCE = [
	"Shipped source must not gain raw TLS/HTTPS client calls.",
	"Bun 1.4.2 is pinned (senpi#3078) and carries CVE-2026-48618: its TLS hostname",
	"check accepts look-alike-dot hosts. We are safe only because every shipped",
	"outbound TLS path takes its host from a parsed URL - new URL() normalizes the",
	"dots. If this call site's host provably comes from new URL(...).hostname or a",
	"literal, add a reviewed entry to ALLOWLIST in scripts/no-raw-tls-client.test.mjs:",
	'    "packages/<pkg>/src/<file>.ts": "<one-line reason: where the host comes from>",',
	"Otherwise route the request through fetch(), which parses the URL.",
].join("\n");

// Direct client calls: the host argument bypasses URL parsing unless the
// allowlist proves otherwise. Bun.connect is flagged in every form because
// its tls: option path bypasses fetch's URL handling entirely.
const CALL_PATTERNS = [
	["tls.connect(", /\btls\s*\.\s*connect\s*\(/g],
	["https.request(", /\bhttps\s*\.\s*request\s*\(/g],
	["https.get(", /\bhttps\s*\.\s*get\s*\(/g],
	["http2.connect(", /\bhttp2\s*\.\s*connect\s*\(/g],
	["Bun.connect(", /\bBun\s*\.\s*connect\s*\(/g],
	["new https.Agent(", /\bnew\s+https\s*\.\s*Agent\s*\(/g],
	["new tls.TLSSocket(", /\bnew\s+tls\s*\.\s*TLSSocket\s*\(/g],
	["checkServerIdentity", /\bcheckServerIdentity\b/g],
];

// Import forms. The module specifier is anchored on both quotes, so
// "node:tlsx" or "./tls" never match. Group 1 catches "import type", which
// is erased at compile time and cannot reach the runtime.
const IMPORT_FROM =
	/import\s+(type\s+)?([^;'"]*?)\s*from\s*["']((?:node:)?(?:tls|https))["']/g;
const REQUIRE_FORM = /\brequire\s*\(\s*["']((?:node:)?(?:tls|https))["']\s*\)/g;
const DYNAMIC_IMPORT_FORM = /\bimport\s*\(\s*["']((?:node:)?(?:tls|https))["']\s*\)/g;

// A node:https import is flagged only when it grants request/get: namespace,
// default, require and dynamic forms grant the whole module; named imports
// are flagged only when request/get is among them, so
// "import { createServer } from 'node:https'" (inbound server) stays clean.
function httpsImportGrantsRequestGet(clause) {
	if (/\*\s*as\b/.test(clause)) return true;
	const named = clause.match(/\{([^}]*)\}/);
	if (!named) return /[\w$]/.test(clause);
	const outsideBraces = clause.replace(/\{[^}]*\}/g, "").replace(/,/g, "").trim();
	if (/[\w$]/.test(outsideBraces)) return true;
	const names = named[1].split(",").map((part) => part.trim().split(/\s+as\s+/)[0].trim());
	return names.includes("request") || names.includes("get");
}

function normalizeCallText(text) {
	return text
		.replace(/\s+/g, " ")
		.replace(/\(\s+/g, "(")
		.replace(/,\s*\)/g, ")")
		.replace(/\s+\)/g, ")");
}

// The matched call plus its balanced argument list, normalized, so a
// reformatted call still matches its pinned allowlist text.
function callText(content, match) {
	const open = match.index + match[0].length - 1;
	let depth = 0;
	let close = -1;
	for (let i = open; i < content.length && i < open + 400; i += 1) {
		const character = content[i];
		if (character === "(") depth += 1;
		else if (character === ")") {
			depth -= 1;
			if (depth === 0) {
				close = i;
				break;
			}
		}
	}
	if (close === -1) close = Math.min(content.length, open + 400) - 1;
	return normalizeCallText(content.slice(match.index, close + 1));
}

function lineNumber(content, index) {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === "\n") line += 1;
	}
	return line;
}

function findRawTlsClients(content) {
	const hits = [];
	for (const [id, pattern] of CALL_PATTERNS) {
		for (const match of content.matchAll(pattern)) {
			hits.push({ line: lineNumber(content, match.index), id, text: callText(content, match) });
		}
	}
	for (const match of content.matchAll(IMPORT_FROM)) {
		const typeClause = match[1];
		const clause = match[2];
		const module = match[3];
		if (typeClause) continue;
		if (module.endsWith("tls")) {
			hits.push({
				line: lineNumber(content, match.index),
				id: 'import from "' + module + '"',
				text: normalizeCallText(match[0]),
			});
		} else if (httpsImportGrantsRequestGet(clause)) {
			hits.push({
				line: lineNumber(content, match.index),
				id: "import granting request/get from node:https",
				text: normalizeCallText(match[0]),
			});
		}
	}
	for (const [pattern, label] of [
		[REQUIRE_FORM, "require"],
		[DYNAMIC_IMPORT_FORM, "import"],
	]) {
		for (const match of content.matchAll(pattern)) {
			hits.push({
				line: lineNumber(content, match.index),
				id: label + '("' + match[1] + '")',
				text: normalizeCallText(match[0]),
			});
		}
	}
	return hits.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

function isScannedSourceFile(relativePath) {
	const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
	if (/\.(test|spec)\.[a-z]+$/.test(name)) return false;
	if (name.endsWith(".d.ts")) return false;
	if (!SOURCE_EXTENSIONS.has(path.extname(name))) return false;
	const segments = relativePath.split("/");
	if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
	return true;
}

function evaluateShippedSource(scan, allowlist) {
	const offenders = [];
	const stale = [];
	for (const item of scan) {
		const hits = findRawTlsClients(item.content);
		if (hits.length === 0) continue;
		if (allowlist.some((entry) => entry.file === item.path)) continue;
		for (const hit of hits) {
			offenders.push(item.path + ":" + hit.line + "  " + hit.text);
		}
	}
	for (const entry of allowlist) {
		const item = scan.find((candidate) => candidate.path === entry.file);
		if (!item) {
			stale.push(entry.file + ": stale allowlist entry (no longer scanned)");
			continue;
		}
		if (findRawTlsClients(item.content).length === 0) {
			stale.push(entry.file + ": stale allowlist entry (no raw TLS client calls left in file)");
		}
		if (!entry.reason || !entry.reason.trim()) {
			stale.push(entry.file + ": allowlist entry without a reason");
		}
	}
	return { offenders, stale };
}

function collectShippedSourceFiles() {
	const files = [];
	const walk = (directory, relativeDirectory) => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const relativePath = relativeDirectory + "/" + entry.name;
			if (entry.isDirectory()) {
				walk(path.join(directory, entry.name), relativePath);
				continue;
			}
			if (isScannedSourceFile(relativePath)) files.push(relativePath);
		}
	};
	for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		walk(path.join(PACKAGES_DIR, pkg.name, "src"), "packages/" + pkg.name + "/src");
	}
	return files.sort();
}

describe("no raw TLS client calls in shipped source (CVE-2026-48618, Bun 1.4.2)", () => {
	it("catches every direct client pattern and import form, with line numbers", () => {
		const samples = [
			["tls.connect(", 'await tls.connect({ host: hostname, port: 443 });'],
			["https.request(", "https.request(url, onResponse);"],
			["https.get(", "https.get(url, onResponse);"],
			["http2.connect(", 'http2.connect("https://example.com");'],
			["Bun.connect(", 'Bun.connect({ hostname: host, port: 1 });'],
			["new https.Agent(", "new https.Agent({ keepAlive: true });"],
			["new tls.TLSSocket(", "new tls.TLSSocket(socket, options);"],
			["checkServerIdentity", "const options = { checkServerIdentity: () => undefined };"],
			['import from "node:tls"', 'import * as tls from "node:tls";'],
			['import from "node:tls"', 'import { connect } from "node:tls";'],
			['import from "tls"', 'import { connect as tlsConnect } from "tls";'],
			['require("node:tls")', 'const tls = require("node:tls");'],
			['import("node:tls")', 'const tls = await import("node:tls");'],
			["import granting request/get from node:https", 'import { request } from "node:https";'],
			["import granting request/get from node:https", 'import { get as httpsGet } from "node:https";'],
			["import granting request/get from node:https", 'import * as https from "node:https";'],
			["import granting request/get from node:https", 'import https from "node:https";'],
			['require("node:https")', 'const https = require("node:https");'],
			['import("node:https")', 'const https = await import("node:https");'],
		];
		for (const [id, sample] of samples) {
			const hits = findRawTlsClients(sample);
			assert.ok(
				hits.some((hit) => hit.id === id),
				"sample not caught as " + id + ": " + sample,
			);
		}
		const positioned = findRawTlsClients(
			'const a = 1;\n\nawait tls.connect({ host: "x", port: 1 });',
		);
		assert.deepEqual(positioned, [
			{ line: 3, id: "tls.connect(", text: 'tls.connect({ host: "x", port: 1 })' },
		]);
	});

	it("does not flag URL-parsed or inbound-server neighbors", () => {
		const samples = [
			'import { createServer } from "node:https";',
			'import type { Agent } from "node:https";',
			'import { connect } from "node:tlsx";',
			'import { connect } from "./tls";',
			"const response = await fetch(url);",
			"const { hostname } = new URL(url);",
			"tls.createServer(options, handler);",
			"https.createServer(options, handler);",
			"Bun.serve({ fetch: handler });",
			'const note = "prefer tls.connect over rolling your own";',
		];
		for (const sample of samples) {
			assert.deepEqual(findRawTlsClients(sample), [], "unexpected hit: " + sample);
		}
	});

	it("collects only shipped source files (tests, fixtures, markdown and references docs are out of scope)", () => {
		assert.equal(isScannedSourceFile("packages/ai/src/api/client.ts"), true);
		assert.equal(isScannedSourceFile("packages/ai/src/api/client.tsx"), true);
		assert.equal(isScannedSourceFile("packages/ai/src/api/client.mjs"), true);
		assert.equal(isScannedSourceFile("packages/ai/src/api/client.test.ts"), false);
		assert.equal(isScannedSourceFile("packages/ai/src/README.md"), false);
		assert.equal(isScannedSourceFile("packages/ai/src/references/notes.ts"), false);
		assert.equal(isScannedSourceFile("packages/ai/src/fixtures/mock.mjs"), false);
		assert.equal(isScannedSourceFile("packages/ai/src/types.d.ts"), false);
	});

	it("holds: shipped production source has no raw TLS client calls outside the allowlist", () => {
		const files = collectShippedSourceFiles();
		assert.ok(files.length > 100, "scanner lost sight of the monorepo");
		const scan = files.map((relativePath) => ({
			path: relativePath,
			content: readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
		}));
		const verdict = evaluateShippedSource(scan, ALLOWLIST);
		assert.deepEqual(verdict.offenders, [], OFFENDER_GUIDANCE);
		assert.deepEqual(
			verdict.stale,
			[],
			"Every allowlist entry must match the shipped tree: file scanned, reason present.",
		);
	});
	describe("allowlist pins exact call sites (in-memory)", () => {
		const pinnedCallEntry = () => ({
			file: "pkg/a.ts",
			call: "http2.connect(baseUrl)",
			count: 2,
			reason: "host comes from new URL(...).hostname",
		});

		it("passes the exact allowlisted calls with the exact counts", () => {
			const entries = [
				pinnedCallEntry(),
				{
					file: "pkg/b.mjs",
					call: 'import { get as httpsGet } from "node:https"',
					count: 1,
					reason: "host is the api.example.com literal",
				},
			];
			const scan = [
				{ path: "pkg/a.ts", content: "one();\nhttp2.connect(baseUrl);\ntwo();\nhttp2.connect(baseUrl);\n" },
				{ path: "pkg/b.mjs", content: 'import { get as httpsGet } from "node:https";\n' },
			];
			assert.deepEqual(evaluateShippedSource(scan, entries), { offenders: [], stale: [] });
		});

		it("fails an allowlisted file that gains a different raw call", () => {
			const scan = [
				{
					path: "pkg/a.ts",
					content: 'http2.connect(baseUrl);\nhttp2.connect(baseUrl);\ntls.connect({ host: "x", port: 1 });\n',
				},
			];
			const verdict = evaluateShippedSource(scan, [pinnedCallEntry()]);
			assert.ok(
				verdict.offenders.some((line) => line.includes('tls.connect({ host: "x", port: 1 })')),
				"expected the new tls.connect to be flagged: " + JSON.stringify(verdict),
			);
		});

		it("fails an extra occurrence of the allowlisted call (count mismatch)", () => {
			const scan = [
				{ path: "pkg/a.ts", content: "http2.connect(baseUrl);\nhttp2.connect(baseUrl);\nhttp2.connect(baseUrl);\n" },
			];
			const verdict = evaluateShippedSource(scan, [pinnedCallEntry()]);
			assert.ok(
				verdict.stale.some((line) => line.includes("expected http2.connect(baseUrl) x2, found x3")),
				"expected a count mismatch: " + JSON.stringify(verdict),
			);
		});

		it("fails a stale entry once the allowlisted call is gone", () => {
			const scan = [{ path: "pkg/a.ts", content: 'tls.connect({ host: "y", port: 2 });\n' }];
			const verdict = evaluateShippedSource(scan, [pinnedCallEntry()]);
			assert.ok(
				verdict.stale.some((line) => line.includes("expected http2.connect(baseUrl) x2, found x0")),
				"expected the stale entry to fail: " + JSON.stringify(verdict),
			);
		});

		it("still matches the pinned text when the call is reformatted", () => {
			const scan = [
				{ path: "pkg/a.ts", content: "http2.connect(\n\tbaseUrl,\n);\nhttp2.connect( baseUrl );\n" },
			];
			assert.deepEqual(evaluateShippedSource(scan, [pinnedCallEntry()]), { offenders: [], stale: [] });
		});
	});
});
