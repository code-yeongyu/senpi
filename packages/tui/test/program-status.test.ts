import assert from "node:assert";
import { describe, it } from "node:test";
import { encodeProgramStatus } from "../src/program-status.ts";

// Protocol bytes are a retained contract: herdr-core and other OSC 7501 terminals parse exactly these reports.
function decodedMessage(sequence: string): string | undefined {
	const msg = /:msg=([A-Za-z0-9+/=]+)\x1b\\$/.exec(sequence)?.[1];
	return msg === undefined ? undefined : Buffer.from(msg, "base64").toString("utf8");
}

describe("encodeProgramStatus (senpi#5321)", () => {
	it("encodes each state with the app repeated and the message as base64", () => {
		assert.strictEqual(encodeProgramStatus({ state: "idle" }, "omo"), "\x1b]7501;state=idle:app=omo\x1b\\");
		assert.strictEqual(
			encodeProgramStatus({ state: "working", message: "Building docs" }, "make"),
			"\x1b]7501;state=working:app=make:msg=QnVpbGRpbmcgZG9jcw==\x1b\\",
		);
		assert.strictEqual(
			encodeProgramStatus({ state: "blocked", kind: "question", message: "Overwrite config.toml?" }, "make"),
			"\x1b]7501;state=blocked:kind=question:app=make:msg=T3ZlcndyaXRlIGNvbmZpZy50b21sPw==\x1b\\",
		);
		assert.strictEqual(encodeProgramStatus(undefined, "omo"), "\x1b]7501;state=clear\x1b\\");
	});

	it("sends kind only with blocked and leaves out an app the protocol would reject", () => {
		assert.strictEqual(
			encodeProgramStatus({ state: "working", kind: "permission" }, "senpi"),
			"\x1b]7501;state=working:app=senpi\x1b\\",
		);
		for (const app of ["o mo", "omo:x", "", "a".repeat(33)])
			assert.strictEqual(encodeProgramStatus({ state: "idle" }, app), "\x1b]7501;state=idle\x1b\\");
		assert.strictEqual(
			encodeProgramStatus({ state: "idle" }, "a".repeat(32)),
			`\x1b]7501;state=idle:app=${"a".repeat(32)}\x1b\\`,
		);
	});

	it("strips controls and bidi or invisible formatting so the terminal does not discard the report", () => {
		const sequence = encodeProgramStatus(
			{ state: "blocked", message: "Auth\x1b]0;owned\x07 \u202eflow\u2066?\u200b\nnext\u009b\ufeff" },
			"omo",
		);
		assert.strictEqual(decodedMessage(sequence), "Auth ]0;owned flow? next");
		assert.strictEqual(
			encodeProgramStatus({ state: "idle", message: "\n\t\u202e " }, "omo"),
			"\x1b]7501;state=idle:app=omo\x1b\\",
		);
	});

	it("truncates the decoded message to 2048 bytes on a UTF-8 boundary", () => {
		const sequence = encodeProgramStatus({ state: "working", message: `a${"é".repeat(1024)}` }, "omo");
		const message = decodedMessage(sequence);
		assert.strictEqual(message, `a${"é".repeat(1023)}`);
		assert.strictEqual(Buffer.byteLength(message ?? "", "utf8"), 2047);
		assert.ok(Buffer.byteLength(sequence, "utf8") <= 4096);
	});
});
