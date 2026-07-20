import { describe, expect, test } from "vitest";
import { buildDynamicSystemPrompt } from "../../src/core/dynamic-prompt/build.ts";
import {
	buildWorkstationSection,
	collectWorkstationFacts,
	type WorkstationFacts,
} from "../../src/core/dynamic-prompt/workstation.ts";

const FACTS: WorkstationFacts = {
	osLine: "darwin",
	kernel: "Darwin 25.3.0",
	arch: "arm64",
	cpu: "Apple M5 Max (18 cores)",
	gpu: "Apple M5 Max",
	terminal: "ghostty 1.3.1",
};

describe("buildWorkstationSection", () => {
	test("renders every provided fact as a tagged block", () => {
		const section = buildWorkstationSection({ selectedTools: ["bash"], facts: FACTS });

		expect(section).toContain("<workstation>");
		expect(section).toContain("</workstation>");
		expect(section).toContain("- OS: darwin (kernel Darwin 25.3.0)");
		expect(section).toContain("- Arch: arm64");
		expect(section).toContain("- CPU: Apple M5 Max (18 cores)");
		expect(section).toContain("- GPU: Apple M5 Max");
		expect(section).toContain("- Terminal: ghostty 1.3.1");
	});

	test("omits missing optional facts instead of rendering empty lines", () => {
		const section = buildWorkstationSection({
			selectedTools: ["bash"],
			facts: { osLine: "linux", kernel: "Linux 6.8.0-x86_64", arch: "x64" },
		});

		expect(section).not.toContain("- CPU:");
		expect(section).not.toContain("- GPU:");
		expect(section).not.toContain("- Terminal:");
	});

	test("names the active local executors in the instruction", () => {
		const both = buildWorkstationSection({ selectedTools: ["bash", "eval", "read"], facts: FACTS });
		const bashOnly = buildWorkstationSection({ selectedTools: ["bash", "read"], facts: FACTS });
		const none = buildWorkstationSection({ selectedTools: ["read", "edit"], facts: FACTS });

		expect(both).toContain("`bash` and `eval` execute");
		expect(bashOnly).toContain("`bash` executes");
		expect(bashOnly).not.toContain("`eval`");
		expect(none).toContain("Everything you run executes");
	});

	test("claude dialect wraps the instruction in an execution_context tag with direct imperatives", () => {
		const section = buildWorkstationSection({ selectedTools: ["bash", "eval"], dialect: "claude", facts: FACTS });

		expect(section).toContain("<execution_context>");
		expect(section).toContain("</execution_context>");
		expect(section).toContain("Code you write may target any machine; code you run always runs here.");
	});

	test("codex dialect is terse without tags or shouting", () => {
		const section = buildWorkstationSection({ selectedTools: ["bash", "eval"], dialect: "codex", facts: FACTS });
		const instruction = section.slice(section.indexOf("</workstation>"));

		expect(instruction).toContain("executed code runs here");
		expect(instruction).not.toContain("<execution_context>");
		expect(instruction).not.toContain("MUST");
		expect(instruction).not.toContain("EXECUTION HAPPENS HERE");
	});

	test("kimi dialect uses positive constraints without all-caps directives", () => {
		const section = buildWorkstationSection({ selectedTools: ["bash", "eval"], dialect: "kimi", facts: FACTS });
		const instruction = section.slice(section.indexOf("</workstation>"));

		expect(instruction).toContain("keep the code portable");
		expect(instruction).not.toMatch(/\b[A-Z]{4,}\b/);
		expect(instruction).not.toContain("<execution_context>");
	});

	test("default dialect carries maximum emphasis", () => {
		const section = buildWorkstationSection({ selectedTools: ["bash", "eval"], facts: FACTS });

		expect(section).toContain("**EXECUTION HAPPENS HERE.**");
		expect(section).toContain("anything you RUN executes HERE");
	});
});

describe("collectWorkstationFacts", () => {
	test("reports this host and caches the snapshot", () => {
		const first = collectWorkstationFacts();
		const second = collectWorkstationFacts();

		expect(first.osLine.startsWith(process.platform)).toBe(true);
		expect(first.arch.length).toBeGreaterThan(0);
		expect(first.kernel.toLowerCase()).not.toContain("unknown");
		expect(second).toBe(first);
	});
});

describe("buildDynamicSystemPrompt workstation integration", () => {
	const baseOptions = {
		cwd: "/test/project",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { bash: "Execute shell commands" },
		promptGuidelines: [],
		contextFiles: [],
		skills: [],
	};

	test("renders the workstation block before the date/cwd footer", () => {
		const prompt = buildDynamicSystemPrompt(baseOptions);

		const workstation = prompt.indexOf("<workstation>");
		const cwd = prompt.indexOf("Current working directory:");
		expect(workstation).toBeGreaterThanOrEqual(0);
		expect(cwd).toBeGreaterThan(workstation);
		expect(prompt).toContain("**EXECUTION HAPPENS HERE.**");
	});

	test("applies the preset-provided dialect", () => {
		const prompt = buildDynamicSystemPrompt({ ...baseOptions, workstationDialect: "claude" });

		expect(prompt).toContain("<execution_context>");
		expect(prompt).not.toContain("EXECUTION HAPPENS HERE");
	});
});
