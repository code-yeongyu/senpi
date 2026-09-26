import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import type { NoticeSpec } from "../src/core/extensions/notice/index.ts";
import {
	detectBunAvailability,
	maybeShowRuntimeNotice,
	RUNTIME_NOTICE_STATE_FILE,
	readShownVersion,
} from "../src/modes/interactive/runtime-notice-presenter.ts";

let root: string;
let agentDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "runtime-notice-"));
	agentDir = join(root, "agent");
	vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_SKIP_RUNTIME_NOTICE", undefined);
	vi.stubEnv("SENPI_SKIP_RUNTIME_NOTICE", undefined);
	// A vitest run started from an OmO Native session inherits the launcher's runtime variables.
	vi.stubEnv("OMO_NATIVE", undefined);
	vi.stubEnv("OMO_RUNTIME", undefined);
	vi.stubEnv("SENPI_RUNTIME", undefined);
	vi.stubEnv("NODE_OPTIONS", undefined);
	vi.stubEnv("HOME", root);
	vi.stubEnv("BUN_INSTALL", join(root, "bun"));
	vi.stubEnv("PATH", join(root, "empty-path"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function collect(): NoticeSpec[] {
	const shown: NoticeSpec[] = [];
	maybeShowRuntimeNotice((spec) => shown.push(spec));
	return shown;
}

describe("maybeShowRuntimeNotice", () => {
	it("shows once on node, records the engine version, and stays quiet on the next launch", () => {
		const first = collect();
		expect(first.map((spec) => spec.title)).toEqual(["Running on Node.js"]);
		expect(first[0]?.extra?.[0]?.text).toBe("Install Bun: curl -fsSL https://bun.sh/install | bash");
		expect(readShownVersion(agentDir)).toBe(VERSION);
		expect(collect()).toEqual([]);
	});

	it("stays quiet when the skip variable is set", () => {
		vi.stubEnv("SENPI_SKIP_RUNTIME_NOTICE", "1");
		expect(collect()).toEqual([]);
		expect(readShownVersion(agentDir)).toBeUndefined();
	});

	it("stays quiet when the user pinned node", () => {
		vi.stubEnv("SENPI_RUNTIME", "node");
		expect(collect()).toEqual([]);
	});

	it("shows again when the recorded version belongs to an older engine", () => {
		collect();
		writeFileSync(join(agentDir, RUNTIME_NOTICE_STATE_FILE), JSON.stringify({ shownVersion: "1999.1.1" }));
		expect(collect()).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(agentDir, RUNTIME_NOTICE_STATE_FILE), "utf8"))).toEqual({
			shownVersion: VERSION,
		});
	});

	it("treats malformed state as never shown", () => {
		collect();
		writeFileSync(join(agentDir, RUNTIME_NOTICE_STATE_FILE), "{not json");
		expect(readShownVersion(agentDir)).toBeUndefined();
		expect(collect()).toHaveLength(1);
	});
});

describe("detectBunAvailability", () => {
	const base = { env: {}, homedir: "/home/u", platform: "linux" as const, realpath: (path: string) => path };

	it("reports missing, outdated, unreadable, and ready bun installs", () => {
		const bun = "/home/u/.bun/bin/bun";
		const exists = (path: string) => path === bun;
		expect(detectBunAvailability({ ...base, exists: () => false, bunVersion: () => "1.4.2" })).toEqual({
			kind: "missing",
		});
		expect(detectBunAvailability({ ...base, exists, bunVersion: () => "1.3.1" })).toEqual({
			kind: "outdated",
			version: "1.3.1",
		});
		expect(detectBunAvailability({ ...base, exists, bunVersion: () => undefined })).toEqual({
			kind: "outdated",
			version: undefined,
		});
		expect(detectBunAvailability({ ...base, exists, bunVersion: () => "1.4.2" })).toEqual({
			kind: "ready",
			version: "1.4.2",
		});
	});
});
