import assert from "node:assert";
import { describe, it } from "node:test";
import { encodeProgramResume, isProgramResumeToken } from "../src/program-resume.ts";

// senpi#7493: protocol bytes are a retained contract. The vectors are the published examples of the OSC 7577
// Program Resume Protocol rev 0.5, whose `mac` values were computed with this dummy token.
const TOKEN = "dummy-token-replace-me";

describe("encodeProgramResume (senpi#7493)", () => {
	it("matches the specification's published reports byte for byte", () => {
		assert.strictEqual(
			encodeProgramResume(
				{
					pid: 74877,
					time: 1795543200,
					argv: ["nvim", "-S", "/home/user/.local/state/nvim/sessions/8f2c1d.vim"],
				},
				TOKEN,
			),
			"\x1b]7577;pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt:mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b\x1b\\",
		);
		assert.strictEqual(
			encodeProgramResume({ pid: 74877, time: 1795543200, clear: true }, TOKEN),
			"\x1b]7577;pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93\x1b\\",
		);
		assert.strictEqual(
			encodeProgramResume({ pid: 74877, time: 1795543200, argv: ["lazygit"], cwd: "/home/user/src/project" }, TOKEN),
			"\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1\x1b\\",
		);
	});

	it("never writes the token itself", () => {
		const sequence = encodeProgramResume({ pid: 1, time: 1795543200, argv: ["omo"] }, TOKEN);
		assert.ok(sequence);
		assert.ok(!sequence.includes(TOKEN));
	});

	it("refuses a command the terminal would reject, so the caller can clear instead", () => {
		const report = (argv: string[], cwd?: string) =>
			encodeProgramResume({ pid: 1, time: 1795543200, argv, ...(cwd === undefined ? {} : { cwd }) }, TOKEN);
		assert.strictEqual(report([]), undefined);
		assert.strictEqual(report([""]), undefined);
		assert.strictEqual(report(["-x"]), undefined);
		assert.strictEqual(report(["./run.sh"]), undefined);
		assert.strictEqual(report(["omo", "line\nbreak"]), undefined);
		assert.strictEqual(report(["omo", "c1\u0085"]), undefined);
		assert.strictEqual(report(["omo"], "project"), undefined);
		// Over the 2048-byte minimum every terminal accepts.
		assert.strictEqual(report(["omo", "x".repeat(2000)]), undefined);
		assert.ok(report(["/usr/bin/omo", ""]));
	});

	it("accepts only tokens of the specified shape", () => {
		assert.strictEqual(isProgramResumeToken(TOKEN), true);
		assert.strictEqual(isProgramResumeToken("a".repeat(64)), true);
		assert.strictEqual(isProgramResumeToken("a".repeat(21)), false);
		assert.strictEqual(isProgramResumeToken("a".repeat(65)), false);
		assert.strictEqual(isProgramResumeToken(`${"a".repeat(22)}:`), false);
		assert.strictEqual(encodeProgramResume({ pid: 1, time: 1795543200, argv: ["omo"] }, "short"), undefined);
	});
});
