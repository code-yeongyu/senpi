import { spawn } from "node:child_process";
import type { Server } from "node:net";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { type QaPort, qaPortsFrom } from "../helpers/qa-port.ts";

export const packageRoot = resolve(import.meta.dirname, "../..");
const tsxCli = resolve(packageRoot, "../../node_modules/tsx/dist/cli.mjs");

export type DaemonCliResult = {
	readonly json: Record<string, unknown>;
	readonly stderr: string;
};

export type StartedDaemon = {
	readonly listen: string;
	readonly port: QaPort;
	readonly started: DaemonCliResult;
};

export async function startDaemonOnQaPort(
	agentDir: string,
	preferredPort: QaPort = 18999,
	extraArgs: readonly string[] = [],
): Promise<StartedDaemon> {
	const failures: string[] = [];
	for (const port of qaPortsFrom(preferredPort)) {
		const listen = `ws://127.0.0.1:${port}`;
		try {
			const started = await runDaemonCli(agentDir, ["start", "--listen", listen, ...extraArgs]);
			return { listen, port, started };
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("EADDRINUSE") || message.includes("address already in use")) {
				failures.push(`${port}:${message}`);
				continue;
			}
			throw error;
		}
	}
	throw new Error(`No free QA daemon port in ${qaPortsFrom().join(", ")} (${failures.join("; ")})`);
}

export function closeServer(server: Server): Promise<void> {
	return new Promise((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
}

export function runDaemonCli(agentDir: string, daemonArgs: readonly string[]): Promise<DaemonCliResult> {
	return new Promise((resolveResult, reject) => {
		const child = spawn(process.execPath, [tsxCli, "src/cli.ts", "app-server", "daemon", ...daemonArgs], {
			cwd: packageRoot,
			env: {
				...process.env,
				PI_OFFLINE: "1",
				HOME: join(agentDir, "home"),
				SENPI_CODING_AGENT_DIR: agentDir,
				SENPI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
				XDG_CACHE_HOME: join(agentDir, "xdg-cache"),
				XDG_CONFIG_HOME: join(agentDir, "xdg-config"),
				XDG_DATA_HOME: join(agentDir, "xdg-data"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			reject(new Error(`daemon command timed out: ${daemonArgs.join(" ")}${output ? `\n${output}` : ""}`));
		}, 60_000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (code !== 0) {
				const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
				reject(new Error(`daemon command failed (${code}): ${daemonArgs.join(" ")}\n${output}`));
				return;
			}
			const lines = stdout.trim().split("\n").filter(Boolean);
			expect(lines).toHaveLength(1);
			const parsed: unknown = JSON.parse(lines[0] ?? "");
			expectRecord(parsed);
			resolveResult({ json: parsed, stderr });
		});
	});
}

export function expectRecord(value: unknown): asserts value is Record<string, unknown> {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	expect(Array.isArray(value)).toBe(false);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected record");
	}
}
