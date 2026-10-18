import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ENV_AGENT_DIR } from "../../src/config.ts";

export function treeDigest(root: string): Readonly<Record<string, string>> {
	const digest: Record<string, string> = {};
	if (!fs.existsSync(root)) return digest;
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const relative = path.relative(root, full);
			if (entry.isDirectory()) {
				digest[`${relative}/`] = (fs.statSync(full).mode & 0o777).toString(8);
				walk(full);
			} else if (entry.isSymbolicLink()) {
				digest[relative] = `-> ${fs.readlinkSync(full)}`;
			} else {
				const hash = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
				digest[relative] = `${(fs.statSync(full).mode & 0o777).toString(8)} ${hash}`;
			}
		}
	};
	walk(root);
	return digest;
}

export function writeUpstreamPiAgentDir(agentDir: string): void {
	fs.mkdirSync(path.join(agentDir, "sessions", "--work-project--"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), '{"theme":"pi-dark"}\n');
	fs.writeFileSync(path.join(agentDir, "auth.json"), '{"anthropic":{"type":"api_key","key":"pi-key"}}\n', {
		mode: 0o600,
	});
	fs.chmodSync(path.join(agentDir, "auth.json"), 0o600);
	fs.writeFileSync(
		path.join(agentDir, "sessions", "--work-project--", "2026-09-01_pi.jsonl"),
		`${JSON.stringify({ type: "session", cwd: "/work/project" })}\n`,
	);
	fs.writeFileSync(path.join(agentDir, "extensions", "my-ext.ts"), "export default () => {};\n");
}

export function withFakeHome(home: string, agentDir: string, run: () => void): void {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousHome = process.env.HOME;
	process.env[ENV_AGENT_DIR] = agentDir;
	process.env.HOME = home;
	try {
		run();
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
	}
}
