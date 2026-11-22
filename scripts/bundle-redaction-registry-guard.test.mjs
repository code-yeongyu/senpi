import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertRedactionRegistryCopies, REDACTION_REGISTRY_SLOT_KEY } from "./bundle-redaction-registry-guard.mjs";

// omo#12965: every emitted copy of the redaction module must read the process-wide registry, or values another copy
// resolved reach that copy's sinks unredacted.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFINITION = "function rememberResolvedReferenceValue(value){registry.add(value)}";

function bundleWith(files) {
	const dir = mkdtempSync(join(tmpdir(), "senpi-redaction-guard-"));
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

describe("bundle redaction registry guard", () => {
	it("names the slot key the module pins", () => {
		const source = readFileSync(
			join(repoRoot, "packages", "coding-agent", "src", "core", "config-reference-redaction.ts"),
			"utf8",
		);
		assert.ok(source.includes(JSON.stringify(REDACTION_REGISTRY_SLOT_KEY)));
	});

	it("accepts a bundle whose every copy carries the slot key", () => {
		const dir = bundleWith({
			"chunks/chunk-A.js": `${DEFINITION};Symbol.for(${JSON.stringify(REDACTION_REGISTRY_SLOT_KEY)})`,
			"chunks/session-worker.js": `function rememberResolvedReferenceValue2(v){};Symbol.for(${JSON.stringify(REDACTION_REGISTRY_SLOT_KEY)})`,
			"cli.js": "console.log(1)",
		});
		try {
			assert.deepEqual(assertRedactionRegistryCopies(dir), ["chunks/chunk-A.js", "chunks/session-worker.js"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a bundle with a copy that keeps a private set", () => {
		const dir = bundleWith({
			"chunks/chunk-A.js": `${DEFINITION};Symbol.for(${JSON.stringify(REDACTION_REGISTRY_SLOT_KEY)})`,
			"chunks/session-worker.js": "var resolvedValues=new Set;function rememberResolvedReferenceValue(v){resolvedValues.add(v)}",
		});
		try {
			assert.throws(() => assertRedactionRegistryCopies(dir), /chunks\/session-worker\.js/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a bundle in which no file defines the module", () => {
		const dir = bundleWith({ "cli.js": "console.log(1)" });
		try {
			assert.throws(() => assertRedactionRegistryCopies(dir), /no emitted file defines/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
