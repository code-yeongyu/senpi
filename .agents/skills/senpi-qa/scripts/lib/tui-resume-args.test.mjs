import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MESSAGES, parseArgs, parseEvidence, parseMessageBound } from "./tui-resume-args.mjs";

const required = ["--select", "latest", "--evidence", "slug"];
const EXACT_EVIDENCE = "local-ignore/qa-evidence/20260820-resume-performance/tui-resume";

test("documented --messages bound is at least 5000", () => {
	assert.ok(MAX_MESSAGES >= 5000);
});

test("parseMessageBound accepts the 5000-message load", () => {
	assert.equal(parseMessageBound("5000"), 5000);
});

test("parseMessageBound rejects counts above the documented safe maximum", () => {
	assert.throws(() => parseMessageBound(String(MAX_MESSAGES + 1)), /safe maximum/);
});

test("parseArgs accepts 5000 messages with required flags", () => {
	const options = parseArgs(["--messages", "5000", ...required]);
	assert.equal(options.messages, 5000);
	assert.equal(options.select, "latest");
	assert.equal(options.evidence, "slug");
});

test("parseArgs rejects --messages above the documented safe maximum", () => {
	assert.throws(
		() => parseArgs(["--messages", String(MAX_MESSAGES + 1), ...required]),
		/safe maximum/,
	);
});

test("parseArgs rejects unknown flags", () => {
	assert.throws(
		() => parseArgs(["--messages", "1", ...required, "--nope", "1"]),
		/Unknown option: --nope/,
	);
});

test("parseEvidence accepts a safe slug", () => {
	assert.equal(parseEvidence("resume-performance"), "resume-performance");
});

test("parseEvidence accepts the exact repo-relative evidence path", () => {
	assert.equal(parseEvidence(EXACT_EVIDENCE), EXACT_EVIDENCE);
});

test("parseArgs accepts the exact repo-relative evidence path", () => {
	const options = parseArgs(["--messages", "1", "--select", "latest", "--evidence", EXACT_EVIDENCE]);
	assert.equal(options.evidence, EXACT_EVIDENCE);
});

test("parseArgs rejects evidence path traversal", () => {
	assert.throws(
		() => parseArgs(["--messages", "1", "--select", "latest", "--evidence", "local-ignore/qa-evidence/../.senpi"]),
		/evidence/,
	);
});

test("parseEvidence rejects traversal, absolute paths, and escapes", () => {
	const bad = [
		"../escape",
		"nested/path",
		"local-ignore/qa-evidence/../.senpi",
		"local-ignore/qa-evidence/foo/../../etc",
		"/tmp/evil",
		"local-ignore/qa-evidence/../../packages",
		`${EXACT_EVIDENCE}/../../secret`,
	];
	for (const value of bad) {
		assert.throws(() => parseEvidence(value), /evidence/);
	}
});
