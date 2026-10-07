import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { getAgentDir, getPackageDir } from "../src/config.ts";
import { resetBrandProfileForTests } from "../src/core/brand.ts";
import { resolveQuarantineAgentDir, scrubAmbientAgentDirEnv, scrubHostLifecycleEnv } from "./support/quarantine.ts";

const AMBIENT_AGENT_DIR_KEYS = [
	"OMO_CODING_AGENT_DIR",
	"SENPI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"OMO_PACKAGE_DIR",
	"SENPI_PACKAGE_DIR",
	"PI_PACKAGE_DIR",
	"SENPI_BRAND",
] as const;

function saveAndPoisonEnv(realDir: string): Record<string, string | undefined> {
	const saved: Record<string, string | undefined> = {};
	for (const key of AMBIENT_AGENT_DIR_KEYS) {
		saved[key] = process.env[key];
	}
	process.env.OMO_CODING_AGENT_DIR = realDir;
	process.env.SENPI_CODING_AGENT_DIR = realDir;
	process.env.OMO_PACKAGE_DIR = "/installed/omo";
	process.env.SENPI_PACKAGE_DIR = "/installed/senpi";
	process.env.PI_PACKAGE_DIR = "/installed/pi";
	process.env.SENPI_BRAND = JSON.stringify({ name: "omo", configDir: ".omo", envPrefix: "OMO" });
	resetBrandProfileForTests();
	return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
	for (const key of AMBIENT_AGENT_DIR_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetBrandProfileForTests();
}

describe("test quarantine resolver", () => {
	test("overrides an inherited SENPI_CODING_AGENT_DIR (omo launcher dirty env)", () => {
		const inherited = "/Users/yeongyu/.omo/agent";
		const result = resolveQuarantineAgentDir({ SENPI_CODING_AGENT_DIR: inherited });

		expect(result).toBeDefined();
		expect(result).not.toBe(inherited);
		expect(result).toContain(tmpdir());
	});

	test("honors SENPI_TEST_USE_REAL_AGENT_DIR=1 opt-in", () => {
		const inherited = "/Users/yeongyu/.omo/agent";
		const result = resolveQuarantineAgentDir({
			SENPI_CODING_AGENT_DIR: inherited,
			SENPI_TEST_USE_REAL_AGENT_DIR: "1",
		});

		expect(result).toBe(inherited);
	});

	test("quarantines when no env is set", () => {
		const result = resolveQuarantineAgentDir({});

		expect(result).toBeDefined();
		expect(result).toContain(tmpdir());
	});

	test("scrubAmbientAgentDirEnv removes every brand agent-dir lane and the brand marker", () => {
		const env = {
			OMO_CODING_AGENT_DIR: "/real",
			SENPI_CODING_AGENT_DIR: "/real",
			PI_CODING_AGENT_DIR: "/real",
			TAU_CODING_AGENT_DIR: "/real",
			OMO_PACKAGE_DIR: "/installed/omo",
			SENPI_PACKAGE_DIR: "/installed/senpi",
			PI_PACKAGE_DIR: "/installed/pi",
			TAU_PACKAGE_DIR: "/installed/tau",
			SENPI_BRAND: "{}",
			UNRELATED: "keep",
		};

		scrubAmbientAgentDirEnv(env);

		expect(env).toEqual({ UNRELATED: "keep" });
	});

	test("quarantine wins over an omo-branded inherited env (2026-08-25 settings.json wipe)", async () => {
		// The omo launcher exports OMO_CODING_AGENT_DIR, SENPI_CODING_AGENT_DIR and SENPI_BRAND
		// to every session, and bash-tool children inherit all three. With the omo brand active,
		// brandEnvNames checks OMO_CODING_AGENT_DIR before the quarantined SENPI_ lane, so a
		// suite that only guards SENPI_ still resolves the real ~/.omo/agent — the exact chain
		// that wiped settings.json on 2026-08-25. The path is only resolved, never written.
		const realDir = "/Users/yeongyu/.omo/agent";
		const saved = saveAndPoisonEnv(realDir);
		try {
			// Computed specifier: re-executes the setup module (query cache-bust) and stays
			// outside static module resolution, so the side effect runs again under the poisoned env.
			const setupModuleSpecifier = "./setup.ts?omo-branded-inherited-env";
			await import(setupModuleSpecifier);

			// Proof the setup module re-executed and quarantined the SENPI_ lane.
			expect(process.env.SENPI_CODING_AGENT_DIR).toContain(tmpdir());
			// The regression: no brand/agent-dir lane may leak the real directory through, and no
			// package-dir lane may redirect asset resolution to an installed runtime.
			expect(getAgentDir()).not.toBe(realDir);
			expect(getPackageDir()).toBe(process.cwd());
		} finally {
			restoreEnv(saved);
		}
	});
});

/** What a host generation exports to the sessions it runs (`TRANSIENT_ENV_NAMES` in host-daemon-env.ts). */
const HOST_LIFECYCLE_ENV = {
	SENPI_RPC_HOST_GENERATION: "10",
	SENPI_RPC_HOST_INSTANCE_ID: "outer-host",
	SENPI_RPC_HOST_DAEMON_DIR: "/outer/rpc-host-daemon/0123456789abcdef",
	SENPI_RPC_HOST_PUBLIC_SOCKET: "/outer/rpc.sock",
	SENPI_RPC_HOST_WATCH_PPID: "1",
	SENPI_RPC_HOST_WATCH_FD: "3",
	SENPI_RPC_HOST_SCRATCH_DIR: "/outer/scratch",
	SENPI_RPC_HOST_CLEANUP_PATHS: "/outer/host.pid",
} as const;

describe("RPC host lifecycle environment", () => {
	test("scrubHostLifecycleEnv removes every SENPI_RPC_HOST_ variable and nothing else", () => {
		const env: Record<string, string> = {
			...HOST_LIFECYCLE_ENV,
			SENPI_RPC_HOST_IDLE_EXIT_MS: "5",
			SENPI_RPC_SESSION_IDLE_EVICTION_MS: "keep",
			UNRELATED: "keep",
		};

		scrubHostLifecycleEnv(env);

		expect(env).toEqual({ SENPI_RPC_SESSION_IDLE_EVICTION_MS: "keep", UNRELATED: "keep" });
	});

	test("the setup module drops an inherited host lifecycle before any test runs", async () => {
		const saved = Object.fromEntries(Object.keys(HOST_LIFECYCLE_ENV).map((key) => [key, process.env[key]]));
		Object.assign(process.env, HOST_LIFECYCLE_ENV);
		try {
			const setupModuleSpecifier = "./setup.ts?inherited-host-lifecycle";
			await import(setupModuleSpecifier);

			for (const key of Object.keys(HOST_LIFECYCLE_ENV)) expect(process.env[key]).toBeUndefined();
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
