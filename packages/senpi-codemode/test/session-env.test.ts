import { describe, expect, it } from "vitest";
import {
	applySessionEnvironment,
	SESSION_ENVIRONMENT_KEYS,
	sessionEnvironmentFrom,
} from "../src/kernels/session-env.ts";

const fullSource = {
	sessionManager: {
		getSessionId: () => "session-77",
		getSessionFile: () => "/tmp/sessions/session-77.jsonl",
	},
	model: { provider: "fake-provider", id: "fake-model" },
	thinkingLevel: "high",
};

describe("session environment contract", () => {
	it("resolves every PI_* session variable the bash tool exposes", () => {
		expect(sessionEnvironmentFrom(fullSource)).toEqual({
			PI_SESSION_ID: "session-77",
			PI_SESSION_FILE: "/tmp/sessions/session-77.jsonl",
			PI_PROVIDER: "fake-provider",
			PI_MODEL: "fake-model",
			PI_REASONING_LEVEL: "high",
		});
	});

	it("omits optional variables the session does not provide", () => {
		const env = sessionEnvironmentFrom({
			sessionManager: { getSessionId: () => "ephemeral-1", getSessionFile: () => undefined },
		});

		expect(env).toEqual({ PI_SESSION_ID: "ephemeral-1" });
		for (const key of SESSION_ENVIRONMENT_KEYS) {
			if (key === "PI_SESSION_ID") continue;
			expect(env).not.toHaveProperty(key);
		}
	});

	it("replaces inherited PI_* values instead of leaking them", () => {
		const base: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			PI_SESSION_ID: "stale-session",
			PI_SESSION_FILE: "stale-file.jsonl",
			PI_PROVIDER: "stale-provider",
			PI_MODEL: "stale-model",
			PI_REASONING_LEVEL: "stale-level",
		};

		const applied = applySessionEnvironment(base, { PI_SESSION_ID: "session-77" });

		expect(applied).toEqual({ PATH: "/usr/bin", PI_SESSION_ID: "session-77" });
		expect(base).toHaveProperty("PI_SESSION_ID", "stale-session");
	});
});
