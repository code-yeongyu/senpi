import * as os from "node:os";
import { describe, expect, test } from "vitest";
import { buildDynamicSystemPrompt } from "../../src/core/dynamic-prompt/build.ts";
import {
	buildWorkstationSection,
	collectWorkstationFacts,
	readWorkstationFacts,
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
	});

	test("codex dialect is terse without tags or shouting", () => {
		const section = buildWorkstationSection({ selectedTools: ["bash", "eval"], dialect: "codex", facts: FACTS });
		const instruction = section.slice(section.indexOf("</workstation>"));

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

// senpi#4660: SENPI_TEST_WORKSTATION pins the CPU model, core count and kernel so a harness driving the real
// CLI gets the same prompt bytes on every host.
function pinned(value: string): NodeJS.ProcessEnv {
	return { ...process.env, SENPI_TEST_WORKSTATION: value };
}

describe("readWorkstationFacts SENPI_TEST_WORKSTATION", () => {
	test("unset: the host's own kernel, CPU model and core count, equal to the cached snapshot", () => {
		const env = { ...process.env };
		delete env.SENPI_TEST_WORKSTATION;

		const facts = readWorkstationFacts(env);

		expect(facts.kernel).toBe(`${os.type()} ${os.release()}`.trim());
		if (facts.cpu !== undefined) expect(facts.cpu.endsWith(` (${os.availableParallelism()} cores)`)).toBe(true);
		expect(facts).toEqual(collectWorkstationFacts());
	});

	test("empty counts as unset", () => {
		expect(readWorkstationFacts(pinned("")).kernel).toBe(`${os.type()} ${os.release()}`.trim());
	});

	test("set: the pinned kernel, CPU model and core count", () => {
		const facts = readWorkstationFacts(
			pinned(JSON.stringify({ cpuModel: "Test CPU", cores: 4, kernel: "TestOS 1.0" })),
		);

		expect(facts.kernel).toBe("TestOS 1.0");
		expect(facts.cpu).toBe("Test CPU (4 cores)");
		expect(facts.gpu).toBeUndefined();
		expect(facts.osLine).toBe(os.platform());
		expect(facts.arch).toBe(os.arch());
	});

	test("the Apple-Silicon GPU line follows the pinned CPU model", () => {
		const facts = readWorkstationFacts(
			pinned(JSON.stringify({ cpuModel: "Apple Test", cores: 2, kernel: "TestOS 1.0" })),
		);

		const appleSilicon = process.platform === "darwin" && os.arch() === "arm64";
		expect(facts.gpu).toBe(appleSilicon ? "Apple Test" : undefined);
	});

	test.each([
		"not json",
		"[]",
		JSON.stringify({ cpuModel: "Test CPU", cores: 4 }),
		JSON.stringify({ cpuModel: "", cores: 4, kernel: "TestOS 1.0" }),
		JSON.stringify({ cpuModel: "Test CPU", cores: 0, kernel: "TestOS 1.0" }),
		JSON.stringify({ cpuModel: "Test CPU", cores: 1.5, kernel: "TestOS 1.0" }),
		JSON.stringify({ cpuModel: "Test CPU", cores: 4, kernel: "TestOS 1.0", gpu: "x" }),
	])("malformed %s throws naming the variable", (value) => {
		expect(() => readWorkstationFacts(pinned(value))).toThrow(/SENPI_TEST_WORKSTATION/);
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

	test("renders the workstation block without a date/cwd footer", () => {
		const prompt = buildDynamicSystemPrompt(baseOptions);

		const workstation = prompt.indexOf("<workstation>");
		expect(workstation).toBeGreaterThanOrEqual(0);
		// senpi#2093: no date/cwd footer follows it any more.
		expect(prompt).not.toContain("Current working directory:");
		expect(prompt).toContain("**EXECUTION HAPPENS HERE.**");
	});

	test("applies the preset-provided dialect", () => {
		const prompt = buildDynamicSystemPrompt({ ...baseOptions, workstationDialect: "claude" });

		expect(prompt).toContain("<execution_context>");
		expect(prompt).not.toContain("EXECUTION HAPPENS HERE");
	});
});
