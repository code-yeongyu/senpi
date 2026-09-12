import { describe, expect, it } from "vitest";
import { buildBashTimeoutPrompt } from "../../src/core/extensions/builtin/bash-timeout/timeout.ts";
import { buildTerminalPromptSection } from "../../src/core/extensions/builtin/terminal/prompt.ts";

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
			for (const evalOnly of [true, false]) {
				const section = buildTerminalPromptSection({ evalOnly });

				expect(section, `evalOnly=${evalOnly}`).toContain("XOR");
				expect(section, `evalOnly=${evalOnly}`).toContain("event");
				expect(section, `evalOnly=${evalOnly}`).toMatch(/fires only/);
			}
		});
	});

	describe("bash timeout policy section", () => {
		const defaults = { defaultSeconds: 1800, maxSeconds: 1800 };

		it("names no monitor call form at all; the terminal section owns the wait routing", () => {
			const prompt = buildBashTimeoutPrompt(defaults, { foregroundWindowSeconds: 60 });

			expect(prompt).not.toContain("monitor(");
			expect(prompt).not.toContain("tool.bash(");
		});

		it("keeps the kill-deadline contract", () => {
			const prompt = buildBashTimeoutPrompt(defaults, { foregroundWindowSeconds: 60 });

			expect(prompt).toContain("## Bash Tool Timeout Policy");
			expect(prompt).toContain("process kill deadline");
			expect(prompt).toContain("Default timeout: 1800s (30 min)");
			expect(prompt).toContain("auto-detaches alive");
			expect(prompt).not.toContain("tmux");
		});

		it("omits the detach rules when no PTY bash tool is live", () => {
			const prompt = buildBashTimeoutPrompt(defaults, {});

			expect(prompt).not.toContain("auto-detaches alive");
			expect(prompt).toContain("## Bash Tool Timeout Policy");
		});
	});
});
