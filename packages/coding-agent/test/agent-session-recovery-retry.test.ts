import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { registerAgentSessionRecoveryRetryBoundaryCase } from "./agent-session-recovery-retry-boundary.ts";

describe("AgentSession recovery retry boundary", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-recovery-retry-"));
		session = undefined;
	});

	afterEach(() => {
		session?.dispose();
		rmSync(tempDir, { recursive: true, force: true });
	});

	registerAgentSessionRecoveryRetryBoundaryCase(
		() => tempDir,
		(createdSession) => {
			session = createdSession;
		},
	);
});
