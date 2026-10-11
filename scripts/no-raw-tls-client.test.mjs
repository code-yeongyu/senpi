#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import {
	collectShippedSourceFiles,
	evaluateShippedSource,
	findRawTlsClients,
	isScannedSourceFile,
	listTrackedFiles,
	readSourceFile,
	REPO_ROOT,
} from "./no-raw-tls-client-scan.test-support.mjs";

// Reviewed allowlist. Each entry pins one exact call: the repo-relative
// file, the detected call's normalized text (whitespace collapsed outside
// string literals, exactly as the failure message prints it), the expected
// occurrence count, and a one-line reason stating where the host comes
// from. A reason is valid only if the host reaches TLS through a URL parse
// - new URL(...).hostname, or an API such as https.get(urlString) /
// http2.connect(authority) that parses its argument - or is a literal.
// Adding or editing an entry is a reviewed act: name the host provenance
// and reference senpi#3078.
const ALLOWLIST = [
	{
		file: "packages/ai/src/api/cursor-agent.ts",
		call: "import * as http2 from \"node:http2\"",
		count: 1,
		reason: "namespace import grants module access to node:http2; every use is one of the two pinned http2.connect(baseUrl) calls below (senpi#3078).",
	},
	{
		file: "packages/ai/src/api/cursor-agent.ts",
		call: "http2.connect(baseUrl)",
		count: 2,
		reason: "the authority argument is the CURSOR_API_URL literal or model.baseUrl config, and http2.connect URL-parses the authority before the TLS handshake (measured on Bun 1.4.2, senpi#3078), so the servername never sees a raw look-alike-dot host.",
	},
];

const OFFENDER_GUIDANCE = [
	"Shipped source must not gain raw TLS/HTTPS client calls.",
	"Bun 1.4.2 is pinned (senpi#3078) and carries CVE-2026-48618: its TLS hostname",
	"check accepts look-alike-dot hosts. We are safe only because every shipped",
	"outbound TLS path reaches its host through a URL parse - new URL() normalizes",
	"the dots, and APIs like https.get(urlString)/http2.connect(authority) parse",
	"their argument. If this call's host provably does the same, or is a literal,",
	"add a reviewed entry to ALLOWLIST in scripts/no-raw-tls-client.test.mjs:",
	'    { file: "<path>", call: "<exact normalized call text>", count: <n>, reason: "<host provenance>" },',
	"Otherwise route the request through fetch(), which parses the URL.",
].join("\n");

describe("no raw TLS client calls in shipped source (CVE-2026-48618, Bun 1.4.2)", () => {
	it("catches every direct client pattern, module form and binding, with line numbers", () => {
		const samples = [
			["tls.connect(", 'await tls.connect({ host: hostname, port: 443 });'],
			["https.request(", "https.request(url, onResponse);"],
			["https.get(", "https.get(url, onResponse);"],
			["http2.connect(", 'http2.connect("https://example.com");'],
			["Bun.connect(", 'Bun.connect({ hostname: host, port: 1 });'],
			["new https.Agent(", "new https.Agent({ keepAlive: true });"],
			["new tls.TLSSocket(", "new tls.TLSSocket(socket, options);"],
			["checkServerIdentity", "const options = { checkServerIdentity: () => undefined };"],
			['require("node:tls")', 'const tls = require("node:tls");'],
			['require("https")', "const https = require('https');"],
			['import("node:tls")', 'const tls = await import("node:tls");'],
			['getBuiltinModule("node:tls")', 'const tls = process.getBuiltinModule("node:tls");'],
			['getBuiltinModule("node:http2")', 'const h2 = process.getBuiltinModule("node:http2");'],
			['re-export from "node:tls"', 'export { connect } from "node:tls";'],
			['re-export from "node:https"', 'export * from "node:https";'],
			['module access: import from "node:http2"', 'import * as http2 from "node:http2";'],
			['module access: import from "node:https"', 'import https from "node:https";'],
			['binding call: httpsGet (imported from "node:https")', 'import { get as httpsGet } from "node:https";\nhttpsGet(url);'],
			['binding call: connect (imported from "node:http2")', 'import { connect } from "node:http2";\nconnect(host);'],
			['binding call: h2c (imported from "node:http2")', 'import { connect as h2c } from "node:http2";\nh2c(host);'],
			['binding call: TLSSocket (imported from "node:tls")', 'import { TLSSocket } from "node:tls";\nnew TLSSocket(sock);'],
			['template import of "node:tls"', "const tls = await import(`node:tls`);"],
			['template require of "node:https"', "const m = require(`node:https`);"],
		];
		for (const [id, sample] of samples) {
			const hits = findRawTlsClients(sample);
			assert.ok(hits.some((hit) => hit.id === id), "sample not caught as " + id + ": " + sample);
		}
		const positioned = findRawTlsClients('const a = 1;\n\nawait tls.connect({ host: "x", port: 1 });');
		assert.deepEqual(positioned, [{ line: 3, id: "tls.connect(", text: 'tls.connect({ host: "x", port: 1 })' }]);
	});

	it("does not flag URL-parsed or inbound-server neighbors", () => {
		const samples = [
			'import { createServer } from "node:http2"; createServer(h);',
			'import { createServer } from "node:https";',
			'import { connect } from "node:tlsx"; connect(h);',
			'import type { Agent } from "node:https";',
			'import { connect } from "node:tls";',
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

	it("collects only tracked files", () => {
		const tracked = new Set(listTrackedFiles());
		for (const file of collectShippedSourceFiles()) {
			assert.ok(tracked.has(file), "untracked file scanned: " + file);
		}
		assert.ok(collectShippedSourceFiles().includes("packages/ai/src/api/cursor-agent.ts"));
	});

	it("tolerates only ENOENT when reading sources", () => {
		assert.equal(readSourceFile(path.join(REPO_ROOT, "definitely-missing-file.ts")), null);
		assert.throws(() => readSourceFile(path.join(REPO_ROOT, "scripts")));
	});

	it("keeps string contents distinct when normalizing", () => {
		const paren = findRawTlsClients('tls.connect({ host: ")" + h });');
		assert.equal(paren[0].text, 'tls.connect({ host: ")" + h })');
		const withSpaces = findRawTlsClients('tls.connect({ host: "a  b" });');
		const single = findRawTlsClients('tls.connect({ host: "a b" });');
		assert.notEqual(withSpaces[0].text, single[0].text);
		const long1 = 'tls.connect({ pad: "' + "x".repeat(500) + '" });';
		const long2 = 'tls.connect({ pad: "' + "x".repeat(499) + 'y" });';
		assert.notEqual(findRawTlsClients(long1)[0].text, findRawTlsClients(long2)[0].text);
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
				{ file: "pkg/b.mjs", call: 'require("node:https")', count: 1, reason: "host is a literal" },
				{ file: "pkg/b.mjs", call: "https.get(url)", count: 1, reason: "host is a literal" },
			];
			const scan = [
				{ path: "pkg/a.ts", content: "one();\nhttp2.connect(baseUrl);\ntwo();\nhttp2.connect(baseUrl);\n" },
				{ path: "pkg/b.mjs", content: 'const https = require("node:https");\nhttps.get(url);\n' },
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

		it("pins a named-import binding by its call; import-pinned entries go stale", () => {
			const entries = [
				{ file: "pkg/b.mjs", call: 'httpsGet(url, { redaction: "none" })', count: 2, reason: "host is a literal" },
			];
			const exact = [
				{
					path: "pkg/b.mjs",
					content:
						'import { get as httpsGet } from "node:https";\nhttpsGet(url, { redaction: "none" });\nhttpsGet(url, { redaction: "none" });\n',
				},
			];
			assert.deepEqual(evaluateShippedSource(exact, entries), { offenders: [], stale: [] });
			const extra = [
				{
					path: "pkg/b.mjs",
				content:
						'import { get as httpsGet } from "node:https";\nhttpsGet(url, { redaction: "none" });\nhttpsGet(url, { redaction: "none" });\nhttpsGet({ host, servername: host });\n',
				},
			];
			assert.ok(evaluateShippedSource(extra, entries).offenders.length > 0, "new binding call must fail");
			const importPinned = [
				{ file: "pkg/b.mjs", call: 'import { get as httpsGet } from "node:https"', count: 1, reason: "x" },
			];
			assert.ok(evaluateShippedSource(exact, importPinned).stale.length > 0, "import-pinned entries must go stale");
		});

		it("still matches the pinned text when the call is reformatted", () => {
			const scan = [{ path: "pkg/a.ts", content: "http2.connect(\n\tbaseUrl,\n);\nhttp2.connect( baseUrl );\n" }];
			assert.deepEqual(evaluateShippedSource(scan, [pinnedCallEntry()]), { offenders: [], stale: [] });
		});
	});

	it("holds: shipped production source has no raw TLS client calls outside the pinned allowlist", () => {
		const files = collectShippedSourceFiles();
		assert.ok(files.length > 100, "scanner lost sight of the monorepo");
		const scan = files.map((relativePath) => ({
			path: relativePath,
			content: readFileSyncCompat(relativePath),
		}));
		const verdict = evaluateShippedSource(scan.filter((item) => item.content !== null), ALLOWLIST);
		assert.deepEqual(verdict.offenders, [], OFFENDER_GUIDANCE);
		assert.deepEqual(
			verdict.stale,
			[],
			"Every allowlist entry must match the shipped tree: file scanned, normalized call text found, occurrence count exact, reason present.",
		);
	});
});

function readFileSyncCompat(relativePath) {
	return readSourceFile(path.join(REPO_ROOT, relativePath));
}
