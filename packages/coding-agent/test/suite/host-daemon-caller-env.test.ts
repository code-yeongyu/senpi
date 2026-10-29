import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonEnvIsAllowed, daemonEnvOverrides } from "../../src/modes/rpc/host-daemon-env.ts";
import type { HostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { initialHostEnvironment, successorHostEnvironment } from "../../src/modes/rpc/host-spawn-environment.ts";
import {
	CALLER_ENV_NAMES_ENV,
	callerEnvPassableNames,
	DEFAULT_CALLER_ENV_NAMES,
	inheritedSessionEnv,
	sessionEnvError,
} from "../../src/modes/rpc/session-caller-env.ts";

const paths = { dir: "/nonexistent/daemon" } as unknown as HostDaemonPaths;

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("a caller's lane never reaches a daemon process (senpi#4381)", () => {
	it("is dropped by name from the environment an ensure hands the daemon", () => {
		expect(daemonEnvIsAllowed("OMOCAT_LANE")).toBe(false);
		expect(daemonEnvOverrides({ OMOCAT_LANE: "lane-a", PATH: "/usr/bin" })).toMatchObject({ OMOCAT_LANE: null });
	});

	it("is absent from the first generation and from a successor generation alike", () => {
		vi.stubEnv("OMOCAT_LANE", "lane-from-the-ensuring-shell");
		const first = initialHostEnvironment({ agentDir: "/nonexistent/agent", paths, instanceId: "i1", generation: 1 });
		const successor = successorHostEnvironment({ paths, instanceId: "i2", generation: 2 });
		expect(first).not.toHaveProperty("OMOCAT_LANE");
		expect(successor).not.toHaveProperty("OMOCAT_LANE");
	});

	it("cannot be forced in through a launch spec override either", () => {
		const env = initialHostEnvironment({
			agentDir: "/nonexistent/agent",
			env: { OMOCAT_LANE: "lane-from-a-spec" },
			paths,
			instanceId: "i1",
			generation: 1,
		});
		expect(env).not.toHaveProperty("OMOCAT_LANE");
	});
});

describe("caller-passable names", () => {
	it("ships exactly OMOCAT_LANE as the default passable name", () => {
		expect([...DEFAULT_CALLER_ENV_NAMES]).toEqual(["OMOCAT_LANE"]);
		expect([...callerEnvPassableNames({})]).toEqual(["OMOCAT_LANE"]);
	});

	it("adds the names the host was configured with, and never a session-owned or host-owned name", () => {
		const names = callerEnvPassableNames({
			[CALLER_ENV_NAMES_ENV]: "WORK_ITEM_ID, PI_SESSION_ID,SENPI_RPC_HOST_INSTANCE_ID,OMO_BROWSER_ENGINE,bad name,",
		});
		expect([...names].sort()).toEqual(["OMOCAT_LANE", "WORK_ITEM_ID"]);
	});

	it("accepts a passable name with a string value", () => {
		expect(sessionEnvError({ OMOCAT_LANE: "lane-a" }, {})).toBeUndefined();
		expect(sessionEnvError(undefined, {})).toBeUndefined();
		expect(sessionEnvError({}, {})).toBeUndefined();
	});

	it("refuses a name that is not passable, naming the offender and the passable set", () => {
		const detail = sessionEnvError({ DATABASE_URL: "x" }, {});
		expect(detail).toContain("DATABASE_URL");
		expect(detail).toContain("OMOCAT_LANE");
		expect(sessionEnvError({ WORK_ITEM_ID: "w1" }, {})).toContain("WORK_ITEM_ID");
		expect(sessionEnvError({ WORK_ITEM_ID: "w1" }, { [CALLER_ENV_NAMES_ENV]: "WORK_ITEM_ID" })).toBeUndefined();
	});

	it("refuses a malformed field by shape before looking at names", () => {
		expect(sessionEnvError("OMOCAT_LANE=x", {})).toBeDefined();
		expect(sessionEnvError(["OMOCAT_LANE"], {})).toBeDefined();
		expect(sessionEnvError({ OMOCAT_LANE: 7 }, {})).toBeDefined();
		expect(sessionEnvError({ "omocat lane": "x" }, {})).toBeDefined();
		expect(sessionEnvError({ OMOCAT_LANE: "a\u0000b" }, {})).toBeDefined();
		expect(sessionEnvError({ OMOCAT_LANE: "x".repeat(4097) }, {})).toBeDefined();
	});

	it("repeats at most the first 64 characters of a caller-supplied name, never its value", () => {
		for (const name of ["a".repeat(10_000), "A".repeat(10_000)]) {
			for (const value of ["secret-value", 7]) {
				const detail = sessionEnvError({ [name]: value }, {}) ?? "";
				expect(detail).toContain(`${name.slice(0, 64)}...`);
				expect(detail).not.toContain(name.slice(0, 65));
				expect(detail).not.toContain("secret-value");
				expect(detail.length).toBeLessThan(200);
			}
		}
		expect(sessionEnvError({ ["B".repeat(64)]: "x" }, {})).toContain(`env.${"B".repeat(64)} is not`);
	});
});

describe("a task child's env", () => {
	it("is the parent's caller env, with the child's own explicit entries winning", () => {
		expect(inheritedSessionEnv({ OMOCAT_LANE: "parent" }, undefined)).toEqual({ OMOCAT_LANE: "parent" });
		expect(inheritedSessionEnv({ OMOCAT_LANE: "parent" }, { OMOCAT_LANE: "child" })).toEqual({
			OMOCAT_LANE: "child",
		});
		expect(inheritedSessionEnv(undefined, { OMOCAT_LANE: "child" })).toEqual({ OMOCAT_LANE: "child" });
		expect(inheritedSessionEnv(undefined, undefined)).toBeUndefined();
		expect(inheritedSessionEnv({}, {})).toBeUndefined();
	});
});
