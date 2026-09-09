import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

/**
 * Regression: `senpi --mode rpc --multi-session` entered `runMultiSessionHost()`
 * (which never returns) BEFORE `main()` reached its `initTheme()` call, so the
 * theme proxy stayed uninitialized for the whole host lifetime. Any extension
 * that touches `theme` during `open_session` (extensions load per session in
 * multi-session mode) crashed with "Theme not initialized. Call initTheme()
 * first." — surfaced by embedders like T3 Code as transcript errors.
 *
 * The probe extension below touches the theme at module load time and then
 * writes a marker file. Pre-fix the touch throws, the marker never appears, and
 * the error text shows up in the host transcript. Post-fix the marker exists
 * and the transcript is clean.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, "..", "..", "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const senpiCli = path.join(packageDir, "src", "cli.ts");
const themeModule = path.join(packageDir, "src", "modes", "interactive", "theme", "theme.ts");

describe("multi-session host initializes the interactive theme", () => {
	let child: ChildProcess | undefined;
	let tmp: string | undefined;

	afterEach(() => {
		child?.kill("SIGTERM");
		child = undefined;
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
		tmp = undefined;
	});

	test("open_session loads a theme-touching extension without crashing", async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-theme-init-"));
		const agentDir = path.join(tmp, "agent");
		const extensionsDir = path.join(agentDir, "extensions");
		const workspace = path.join(tmp, "workspace");
		const marker = path.join(tmp, "theme-probe-loaded");
		fs.mkdirSync(extensionsDir, { recursive: true });
		fs.mkdirSync(workspace, { recursive: true });
		fs.writeFileSync(
			path.join(extensionsDir, "theme-probe.ts"),
			[
				`import * as fs from "node:fs";`,
				`import { theme } from ${JSON.stringify(themeModule)};`,
				"// Touching the theme at extension load time is exactly what crashed pre-fix.",
				`theme.fg("accent", "probe");`,
				`fs.writeFileSync(${JSON.stringify(marker)}, "loaded");`,
				"export default function themeProbe() {}",
			].join("\n"),
		);

		const spawned = spawn(process.execPath, [tsxCli, senpiCli, "--mode", "rpc", "--multi-session"], {
			cwd: workspace,
			env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		child = spawned;

		let stdout = "";
		let stderr = "";
		spawned.stdout.on("data", (chunk: Buffer) => {
			stdout += String(chunk);
		});
		spawned.stderr.on("data", (chunk: Buffer) => {
			stderr += String(chunk);
		});

		const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
			const fail = (reason: unknown) =>
				reject(
					new Error(`host ended before responding (${String(reason)})\nstdout:\n${stdout}\nstderr:\n${stderr}`),
				);
			spawned.on("error", fail);
			spawned.on("exit", (code) => fail(`exit ${code}`));
			let buffer = "";
			spawned.stdout.on("data", (chunk: Buffer) => {
				buffer += String(chunk);
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (!line) continue;
					try {
						const parsed = JSON.parse(line) as Record<string, unknown>;
						if (parsed.type === "response" && parsed.id === "open-1") {
							resolve(parsed);
							return;
						}
					} catch {
						// Non-JSON startup noise is fine; only framed responses matter.
					}
				}
			});
			spawned.stdin.write(`${JSON.stringify({ id: "open-1", type: "open_session", cwd: workspace })}\n`);
		});

		const transcript = `${stdout}\n${stderr}`;
		expect(transcript).not.toContain("Theme not initialized");
		expect(
			fs.existsSync(marker),
			`theme probe extension never loaded\nresponse: ${JSON.stringify(response)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		).toBe(true);
	}, 120_000);
});
