import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cli = join(root, "packages/coding-agent/src/cli.ts");

// Exercise the real source CLI and its ProcessTerminal over deterministic virtual TTY pipes.
// This needs no native PTY dependency (ConPTY is not installed in the Windows test checkout).
it.each([80, 120])(
	"renders and switches canonical footer accounts in the source CLI at %i columns",
	async (width) => {
		const dir = mkdtempSync(join(tmpdir(), "footer-cli-"));
		const screen = new xterm.Terminal({ cols: width, rows: 36, allowProposedApi: true });
		const env: NodeJS.ProcessEnv = {};
		for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "PATHEXT"]) {
			if (process.env[key] !== undefined) env[key] = process.env[key];
		}
		Object.assign(env, {
			SENPI_CODING_AGENT_DIR: dir,
			SENPI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
			HOME: dir,
			USERPROFILE: dir,
			SENPI_OFFLINE: "1",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			SENPI_OMO_LOCAL_UPDATE: "0",
			SENPI_CLI_ISOLATED_CHILD: "1",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
		});
		const access = `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-workspace" } })).toString("base64url")}.fake`;
		const slots = [
			{ name: "default", access, refresh: "fake-refresh-sentinel", expires: 1, displayName: "Personal" },
			{
				name: "login-2",
				access,
				refresh: "fake-refresh-sentinel",
				expires: 4_102_444_800_000,
				verifiedIdentity: {
					userId: "fake-user",
					workspaceId: "fake-workspace",
					verifiedEmail: "research@example.test",
				},
			},
		];
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({ "chatgpt-subscription": { type: "oauth", ...slots[1], pinned: "login-2", accounts: slots } }),
		);
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ theme: "dark", quietStartup: true, experimental: { sharedHost: false } }),
		);
		const args = [
			"--provider",
			"chatgpt-subscription",
			"--model",
			"gpt-5.5",
			"--no-context-files",
			"--no-skills",
			"--no-extensions",
			"--approve",
		];
		const bootstrap = `Object.defineProperty(process.stdout, 'isTTY', {value:true});
Object.defineProperty(process.stdout, 'columns', {value:${width}});
Object.defineProperty(process.stdout, 'rows', {value:36});
Object.defineProperty(process.stdin, 'isTTY', {value:true});
process.stdin.setRawMode = () => process.stdin;
process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(pathToFileURL(cli).href)});`;
		const child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href,
				"--input-type=module",
				"--eval",
				bootstrap,
			],
			{ cwd: dir, env, stdio: "pipe" },
		);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		const waiters = new Set<() => void>();
		const grid = () =>
			Array.from(
				{ length: screen.rows },
				(_, index) =>
					screen.buffer.active.getLine(screen.buffer.active.viewportY + index)?.translateToString(true) ?? "",
			);
		child.stdout.on("data", (chunk: Buffer) =>
			screen.write(chunk, () => {
				for (const notify of waiters) notify();
			}),
		);
		const waitFor = (predicate: (lines: string[]) => boolean) =>
			new Promise<string[]>((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new Error(`CLI footer deadline; stderr: ${stderr}; screen: ${grid().join("\n")}`));
				}, 30000);
				const check = () => {
					const lines = grid();
					if (!predicate(lines)) return;
					clearTimeout(timer);
					waiters.delete(check);
					resolve(lines);
				};
				waiters.add(check);
				check();
			});
		try {
			const initial = await waitFor((lines) =>
				lines.some((line) => line.includes("(login-2)") && line.includes("[valid]")),
			);
			expect(initial.join("\n")).toContain("research");
			const switched = waitFor((lines) =>
				lines.some((line) => line.includes("(default)") && line.includes("[refresh-on-use]")),
			);
			child.stdin.write("/gpt-account pin default\r");
			const final = await switched;
			expect(final.join("\n")).toContain("Personal");
			expect(final.join("\n")).not.toContain("fake-refresh-sentinel");
			expect(
				final.filter((line) => line.includes("[refresh-on-use]")).some((line) => line.includes("login-2")),
			).toBe(false);
			for (const line of final) expect(line.length).toBeLessThanOrEqual(width);
			console.log(
				JSON.stringify({
					width,
					footer: final.filter((line) => line.includes("ChatGPT") || line.includes("gpt-5.5")),
				}),
			);
		} finally {
			child.kill();
			await closed;
			screen.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	45000,
);
