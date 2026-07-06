/**
 * NeoRuntimeOptions -> classic rpc argv conversion.
 *
 * Guards that every runtime field threaded into NeoRuntimeOptions is actually
 * emitted as the classic flag a `senpi --mode rpc` worker consumes, and that
 * initial inputs are NOT emitted (they travel as a prompt command, not argv).
 */

import { describe, expect, it } from "vitest";
import { neoRuntimeOptionsToRpcArgv } from "../src/modes/rpc/neo-runtime-options-argv.ts";

describe("neoRuntimeOptionsToRpcArgv", () => {
	it("always starts with --mode rpc", () => {
		expect(neoRuntimeOptionsToRpcArgv({}).slice(0, 2)).toEqual(["--mode", "rpc"]);
	});

	it("emits provider/model/thinking/api-key", () => {
		const argv = neoRuntimeOptionsToRpcArgv({
			provider: "anthropic",
			model: "claude",
			thinking: "high",
			apiKey: "sk-x",
		});
		expect(argv).toEqual(
			expect.arrayContaining([
				"--provider",
				"anthropic",
				"--model",
				"claude",
				"--thinking",
				"high",
				"--api-key",
				"sk-x",
			]),
		);
	});

	it("joins list options with commas", () => {
		const argv = neoRuntimeOptionsToRpcArgv({ models: ["a", "b"], tools: ["read", "bash"], excludeTools: ["write"] });
		expect(argv).toEqual(
			expect.arrayContaining(["--models", "a,b", "--tools", "read,bash", "--exclude-tools", "write"]),
		);
	});

	it("emits boolean flags only when true", () => {
		const on = neoRuntimeOptionsToRpcArgv({ noSession: true, noTools: true, noContextFiles: true, resume: true });
		expect(on).toEqual(expect.arrayContaining(["--no-session", "--no-tools", "--no-context-files", "--resume"]));
		const off = neoRuntimeOptionsToRpcArgv({ noSession: false });
		expect(off).not.toContain("--no-session");
	});

	it("maps projectTrustOverride to --approve / --no-approve", () => {
		expect(neoRuntimeOptionsToRpcArgv({ projectTrustOverride: true })).toContain("--approve");
		expect(neoRuntimeOptionsToRpcArgv({ projectTrustOverride: false })).toContain("--no-approve");
		expect(neoRuntimeOptionsToRpcArgv({})).not.toContain("--approve");
	});

	it("repeats resource flags per value", () => {
		const argv = neoRuntimeOptionsToRpcArgv({ extensions: ["./a.ts", "./b.ts"], skills: ["./s"] });
		const extIdx = argv.filter((a) => a === "--extension");
		expect(extIdx).toHaveLength(2);
		expect(argv).toEqual(
			expect.arrayContaining(["--extension", "./a.ts", "--extension", "./b.ts", "--skill", "./s"]),
		);
	});

	it("emits unknown (extension) flags", () => {
		const argv = neoRuntimeOptionsToRpcArgv({ unknownFlags: { plan: true, mode: "fast", off: false } });
		expect(argv).toEqual(expect.arrayContaining(["--plan", "--mode", "fast"]));
		expect(argv).not.toContain("--off");
	});

	it("does NOT emit initial inputs (messages / fileArgs)", () => {
		const argv = neoRuntimeOptionsToRpcArgv({ messages: ["hello"], fileArgs: ["prompt.md"] });
		expect(argv).not.toContain("hello");
		expect(argv).not.toContain("@prompt.md");
		expect(argv).not.toContain("prompt.md");
	});
});
