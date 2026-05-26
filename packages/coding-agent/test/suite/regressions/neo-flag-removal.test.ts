import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseArgs, printHelp } from "../../../src/cli/args.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const codingAgentRoot = resolve(testDir, "../../..");
const repoRoot = resolve(codingAgentRoot, "../..");

function captureHelp(): string {
	const originalLog = console.log;
	let output = "";
	console.log = (message?: unknown): void => {
		output += `${String(message ?? "")}\n`;
	};
	try {
		printHelp();
	} finally {
		console.log = originalLog;
	}
	return output;
}

describe("neo flag removal", () => {
	test("help omits --neo flag", () => {
		// Given: the public CLI help text is rendered through the real help printer.
		// When: the user asks for available options.
		const help = captureHelp();

		// Then: the removed neo flag and binary name are absent from the public surface.
		expect(help, "help output must not advertise the removed --neo flag").not.toContain("--neo");
		expect(help, "help output must not advertise the removed neo TUI binary").not.toContain("senpi-neo-tui");
	});

	test("--neo is rejected as unknown option", () => {
		// Given: a user invokes the removed flag directly.
		// When: args are parsed through the production parser.
		const parsed = parseArgs(["--neo"]);

		// Then: the flag fails loudly instead of being accepted or routed as an extension flag.
		expect(parsed.diagnostics, "removed --neo must emit an error diagnostic").toContainEqual({
			type: "error",
			message: "Unknown option: --neo",
		});
		expect(parsed.unknownFlags.has("neo"), "removed --neo must not become an extension flag").toBe(false);
	});

	test("default binary path still resolves without neo", () => {
		// Given: normal CLI dispatch source should use the default interactive mode.
		const mainSource = readFileSync(resolve(codingAgentRoot, "src/main.ts"), "utf-8");

		// When: the source is inspected for obsolete native TUI dispatch wiring.
		// Then: the default path no longer imports or branches into neo-mode.
		expect(mainSource, "main.ts must not import the removed neo launcher").not.toContain("runNeoMode");
		expect(mainSource, "main.ts must not branch on the removed parsed.neo flag").not.toContain("parsed.neo");
	});

	test("package metadata has no neo binary entries", () => {
		// Given: package and workspace metadata define what binaries are built and shipped.
		const packageJson = readFileSync(resolve(codingAgentRoot, "package.json"), "utf-8");
		const rootPackageJson = readFileSync(resolve(repoRoot, "package.json"), "utf-8");
		const ciWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf-8");

		// When: release/build metadata is checked for the removed native binary.
		// Then: no package-facing build path references the neo TUI binary.
		expect(packageJson, "coding-agent package metadata must not build or ship neo binaries").not.toContain("neo-tui");
		expect(rootPackageJson, "workspace metadata must not expose packages/neo-tui as a package").not.toContain(
			"neo-tui",
		);
		expect(ciWorkflow, "CI must not run Rust neo-tui binary checks").not.toContain("senpi-neo-tui");
	});
});
