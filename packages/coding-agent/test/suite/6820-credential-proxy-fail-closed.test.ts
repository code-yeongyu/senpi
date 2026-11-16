// senpi#6820 security contract: when the loopback proxy cannot bind, the declared credential stays withheld from
// agent children and no route is advertised; the engine never falls back to passing the raw value.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateCredentialProxy, releaseCredentialProxy } from "../../src/core/credential-proxy/runtime.ts";
import { getShellEnv } from "../../src/utils/shell.ts";

vi.mock("node:http", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:http")>();
	const failingServer = () => {
		const server = new EventEmitter();
		return Object.assign(server, {
			listen: () => {
				queueMicrotask(() =>
					server.emit("error", Object.assign(new Error("listen EPERM 127.0.0.1"), { code: "EPERM" })),
				);
				return server;
			},
		});
	};
	return { ...actual, createServer: failingServer };
});

const SECRET = "test-fake-credential-6820-failclosed";
const holder = {};

afterEach(async () => {
	await releaseCredentialProxy(holder);
	vi.unstubAllEnvs();
});

describe("credential proxy that cannot bind (senpi#6820)", () => {
	it("rejects activation and keeps the credential withheld with no route", async () => {
		vi.stubEnv("TEST_CRED_6820", SECRET);
		const warnings: string[] = [];
		const activation = activateCredentialProxy({
			holder,
			settings: {
				credentials: [
					{ env: "TEST_CRED_6820", origin: "https://api.example.invalid", baseUrlEnv: "TEST_CRED_6820_BASE_URL" },
				],
			},
			warn: (message) => warnings.push(message),
		});
		expect(getShellEnv().TEST_CRED_6820).toBe("senpi-credential-proxy-placeholder");
		await expect(activation).rejects.toThrow(/EPERM/);
		const env = getShellEnv();
		expect(env.TEST_CRED_6820).toBe("senpi-credential-proxy-placeholder");
		expect(env.TEST_CRED_6820_BASE_URL).toBeUndefined();
		expect(Object.values(env)).not.toContain(SECRET);
		expect(warnings.join("\n")).not.toContain(SECRET);
	});
});
