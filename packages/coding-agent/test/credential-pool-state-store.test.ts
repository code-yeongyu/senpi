import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	acquireHalfOpenLease,
	CredentialSlotRepository,
	credentialPoolStatePath,
	slotHealth,
} from "../src/core/credential-pool/state-store.ts";
import { FILE_STORAGE_LOCK_OPTIONS } from "../src/core/lockfile-policy.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const NOW = 1_756_000_000_000;

let dir: string;
let path: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cred-pool-state-"));
	path = join(dir, "credential-pool-state.json");
	repository = new CredentialSlotRepository(path);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("credential pool state sidecar", () => {
	test("default path lives in the agent dir", () => {
		expect(credentialPoolStatePath("/tmp/agent")).toBe("/tmp/agent/credential-pool-state.json");
	});

	test("two repository instances wait through a real shared lock", async () => {
		await repository.listSlots("openai", "api");
		const release = await lockfile.lock(path, { ...FILE_STORAGE_LOCK_OPTIONS, retries: 0 });
		const waiting = expect(new CredentialSlotRepository(path).listSlots("openai", "api")).resolves.toEqual({});
		await new Promise<void>((resolve) => setImmediate(resolve));
		await release();
		await waiting;
	});

	test("a cooldown written before a restart still suppresses the slot after re-reading", async () => {
		await repository.mutateSlotState("openai", "api", "work", () => ({
			blockedUntil: NOW + 120_000,
			blockReason: "rate_limit",
			failureCount: 1,
		}));

		const restarted = new CredentialSlotRepository(path);
		const slots = await restarted.listSlots("openai", "api");
		expect(slots.work).toMatchObject({ blockedUntil: NOW + 120_000, blockReason: "rate_limit" });
		expect(slotHealth(slots.work, NOW)).toBe("blocked");
	});

	test("stateVersion increments on every mutation and deletion removes the slot", async () => {
		const first = await repository.mutateSlotState("openai", "api", "work", () => ({ failureCount: 1 }));
		const second = await repository.mutateSlotState("openai", "api", "work", (current) => ({
			...current,
			failureCount: 2,
		}));
		expect(first?.stateVersion).toBe(1);
		expect(second?.stateVersion).toBe(2);

		await repository.mutateSlotState("openai", "api", "work", () => undefined);
		expect(await repository.listSlots("openai", "api")).toEqual({});
	});

	test("an expired cooldown becomes half_open via exactly one lease, not blocked or ready", async () => {
		await repository.mutateSlotState("openai", "api", "work", () => ({
			blockedUntil: NOW - 1_000,
			blockReason: "rate_limit",
		}));

		const lease = await acquireHalfOpenLease(repository, "openai", "api", "work", { now: NOW });
		expect(lease?.leaseId).toBeTruthy();
		const slots = await repository.listSlots("openai", "api");
		expect(slotHealth(slots.work, NOW)).toBe("half_open");

		const second = await acquireHalfOpenLease(repository, "openai", "api", "work", { now: NOW });
		expect(second).toBeUndefined();
	});

	test("an auth block never leases a probe; only re-login clears it", async () => {
		await repository.mutateSlotState("openai", "api", "work", () => ({
			blockedUntil: NOW - 1_000,
			blockReason: "auth_error",
		}));

		const lease = await acquireHalfOpenLease(repository, "openai", "api", "work", { now: NOW });
		expect(lease).toBeUndefined();
	});

	test("two custom agent directories give ModelRuntime isolated repositories", async () => {
		const one = join(dir, "one");
		const two = join(dir, "two");
		const runtimeOne = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			agentDir: one,
		});
		const runtimeTwo = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			agentDir: two,
		});
		const repoOne = (await (runtimeOne as any).loadCredentialPool()).repository as CredentialSlotRepository;
		const repoTwo = (await (runtimeTwo as any).loadCredentialPool()).repository as CredentialSlotRepository;
		await repoOne.mutateSlotState("openai", "stored", "work", () => ({ failureCount: 2 }));
		expect(await repoTwo.listSlots("openai", "stored")).toEqual({});
		expect(readFileSync(join(one, "credential-pool-state.json"), "utf8")).toContain("work");
		expect(readFileSync(join(two, "credential-pool-state.json"), "utf8")).not.toContain("work");
	});

	test("createAgentSessionServices keeps pool sidecars under each custom agent directory", async () => {
		const one = join(dir, "service-one");
		const two = join(dir, "service-two");
		const servicesOne = await createAgentSessionServices({ cwd: dir, agentDir: one });
		const servicesTwo = await createAgentSessionServices({ cwd: dir, agentDir: two });
		const repoOne = (await (servicesOne.modelRuntime as any).loadCredentialPool())
			.repository as CredentialSlotRepository;
		const repoTwo = (await (servicesTwo.modelRuntime as any).loadCredentialPool())
			.repository as CredentialSlotRepository;
		await repoOne.mutateSlotState("openai", "stored", "work", () => ({ failureCount: 2 }));
		expect(await repoTwo.listSlots("openai", "stored")).toEqual({});
		expect(readFileSync(join(one, "credential-pool-state.json"), "utf8")).toContain("work");
		expect(readFileSync(join(two, "credential-pool-state.json"), "utf8")).not.toContain("work");
	});

	test("two repositories keep health state isolated", async () => {
		const second = new CredentialSlotRepository(join(dir, "other-state.json"));
		await repository.mutateSlotState("openai", "stored", "work", () => ({ failureCount: 2 }));
		expect(await second.listSlots("openai", "stored")).toEqual({});
	});

	test("the installation key is stable and env revisions rotate with the value", async () => {
		const key1 = await repository.installationKey();
		const key2 = await new CredentialSlotRepository(path).installationKey();
		expect(key1).toBe(key2);
		expect(key1).toMatch(/^[0-9a-f]{64}$/);

		const revisionA = await repository.envCredentialRevision("OPENAI_API_KEY", "value-a");
		const revisionASame = await repository.envCredentialRevision("OPENAI_API_KEY", "value-a");
		const revisionB = await repository.envCredentialRevision("OPENAI_API_KEY", "value-b");
		expect(revisionA).toBe(revisionASame);
		expect(revisionA).not.toBe(revisionB);
		expect(readFileSync(path, "utf-8")).not.toContain("value-a");
	});

	test("the sidecar file is created at mode 0600 and an invalid document self-heals", async () => {
		await repository.mutateSlotState("openai", "api", "work", () => ({ failureCount: 1 }));
		expect(statSync(path).mode & 0o777).toBe(0o600);

		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, "not json at all", { encoding: "utf-8", mode: 0o600 });
		const healed = new CredentialSlotRepository(path);
		expect(await healed.listSlots("openai", "api")).toEqual({});
		const state = await healed.mutateSlotState("openai", "api", "work", () => ({ failureCount: 1 }));
		expect(state?.stateVersion).toBe(1);
	});
});
