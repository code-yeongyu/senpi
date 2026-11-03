import { describe, expect, it } from "vitest";
import { buildTerminalPromptSection } from "../../src/core/extensions/builtin/terminal/prompt.ts";
import { monitorSourceOf } from "../../src/core/extensions/builtin/terminal/tools/monitor-rpc.ts";

/**
 * The eval-only policy hides `bash`, `powershell`, `workflow` and `monitor` from the
 * model's direct tool list whenever the session has an `eval` tool, so every prose
 * surface that shows a call shape for one of them must show the reachable form.
 *
 * Both surfaces are appended to the system prompt unconditionally, so a hardcoded
 * direct call shape is a prompt that describes an impossible call. The assertions
 * key on the call shapes themselves, in both directions, so neither branch can
 * silently adopt the other's wording.
 */

const DIRECT_BASH_SHAPE = /(^|[^.\w])bash\(\{/;
const DIRECT_MONITOR_SHAPE = /(^|[^.\w])monitor\(\{/;

describe("eval-only prose call forms", () => {
	describe("terminal prompt section", () => {
		it("teaches tool.bash( and tool.monitor( when the session routes through eval", () => {
			const section = buildTerminalPromptSection({ evalOnly: true });

			expect(section).toContain("tool.bash({ command");
			expect(section).toContain("tool.monitor({ description, command");
			expect(section).toContain("tool.monitor({ description, path");
			expect(section).toContain('tool.monitor({ action: "rearm"');
			expect(section).not.toMatch(DIRECT_BASH_SHAPE);
			expect(section).not.toMatch(DIRECT_MONITOR_SHAPE);
		});

		it("keeps the direct call shapes when no eval tool is registered", () => {
			const section = buildTerminalPromptSection({ evalOnly: false });

			expect(section).toMatch(DIRECT_BASH_SHAPE);
			expect(section).toMatch(DIRECT_MONITOR_SHAPE);
			expect(section).not.toContain("tool.bash(");
			expect(section).not.toContain("tool.monitor(");
		});

		it("keeps the steering companions on their direct call shapes in both branches", () => {
			for (const evalOnly of [true, false]) {
				const section = buildTerminalPromptSection({ evalOnly });

				expect(section, `evalOnly=${evalOnly}`).toContain("bash_output({ bash_id");
				expect(section, `evalOnly=${evalOnly}`).toContain("bash_input({ bash_id");
				expect(section, `evalOnly=${evalOnly}`).toContain("bash_resize({ bash_id");
				expect(section, `evalOnly=${evalOnly}`).toContain("kill_bash({ bash_id");
				expect(section, `evalOnly=${evalOnly}`).not.toContain("tool.bash_output(");
				expect(section, `evalOnly=${evalOnly}`).not.toContain("tool.kill_bash(");
			}
		});

		it("preserves the monitor branch teaching in both branches", () => {
			// The one-source rule the prompt teaches is enforced by the tool, so it is pinned there, not by wording.
			expect(monitorSourceOf({ description: "d", command: "c", path: "p" })).toHaveProperty("error");
			expect(monitorSourceOf({ description: "d" })).toHaveProperty("error");
			expect(monitorSourceOf({ description: "d", target: "children" })).toBe("rpc");
			for (const evalOnly of [true, false]) {
				const section = buildTerminalPromptSection({ evalOnly });

				expect(section, `evalOnly=${evalOnly}`).toContain("event");
				expect(section, `evalOnly=${evalOnly}`).toMatch(/fires only/);
			}
		});
	});

	describe("bash timeout facts in the terminal section (senpi#5335)", () => {
		it("names the configured foreground window and default timeout", () => {
			const section = buildTerminalPromptSection({
				evalOnly: true,
				foregroundWindowSeconds: 25,
				defaultTimeoutSeconds: 7,
			});

			expect(section).toContain("25s");
			expect(section).toContain("default 7)");
			expect(section).toContain("process kill deadline");
		});

		it("omits the bash detach and timeout facts when no PTY bash tool is live", () => {
			const section = buildTerminalPromptSection({ evalOnly: true, ptyBash: false });

			expect(section).not.toContain("auto-detaches");
			expect(section).not.toContain("run_in_background");
		});
	});
});
