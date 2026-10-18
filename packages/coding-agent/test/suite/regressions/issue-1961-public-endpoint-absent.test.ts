import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPERSESSION_POLL_MS, watchForSupersession } from "../../../src/modes/rpc/host-supersession.ts";
import { type SocketFileIdentity, statSocketIdentity } from "../../../src/modes/rpc/socket-ownership.ts";

// Each poll classifies the endpoint with a real stat, which answers on the I/O loop, not as a
// microtask, so advancing fake time alone can outrun it (#2351). The real classifier stays in place;
// the probe only records every observation in flight and can hold their answers back.
const probe = vi.hoisted(() => ({ inFlight: [] as Promise<unknown>[], held: undefined as Promise<void> | undefined }));
vi.mock("../../../src/modes/rpc/socket-ownership.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/socket-ownership.ts")>();
	const classifyEndpointOwnership: typeof actual.classifyEndpointOwnership = (...args) => {
		const observation = actual.classifyEndpointOwnership(...args).then(async (ownership) => {
			await probe.held;
			return ownership;
		});
		probe.inFlight.push(observation);
		return observation;
	};
	return { ...actual, classifyEndpointOwnership };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	probe.held = undefined;
	probe.inFlight.length = 0;
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 30_000);

async function boundEndpoint(): Promise<{ path: string; identity: SocketFileIdentity }> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-endpoint-absent-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "rpc.sock");
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const identity = await statSocketIdentity(path);
	if (identity === undefined) throw new Error(`${path}: a bound socket must have an identity`);
	return { path, identity };
}

async function settleObservations(): Promise<void> {
	await Promise.allSettled(probe.inFlight.splice(0));
}

async function runSettledPolls(count: number): Promise<void> {
	for (let poll = 0; poll < count; poll++) {
		await vi.advanceTimersByTimeAsync(SUPERSESSION_POLL_MS);
		await settleObservations();
	}
}

async function watchRemovedEndpoint(): Promise<{ losses: () => number }> {
	const endpoint = await boundEndpoint();
	let lost = 0;
	vi.useFakeTimers();
	const stop = watchForSupersession({ path: endpoint.path, identity: endpoint.identity }, () => {
		lost += 1;
	});
	cleanups.push(async () => stop());
	await unlink(endpoint.path);
	return { losses: () => lost };
}

describe("issue 1961: a generation that lost its public entry", () => {
	it("notices the loss, so it can drain instead of living on unreachable", async () => {
		// given: a generation serving the public endpoint whose entry it bound
		// when: the bound name is removed, so nothing can resolve the endpoint any more
		const watch = await watchRemovedEndpoint();
		await runSettledPolls(6);

		// then: the generation learns it stopped owning its endpoint, exactly once
		expect(watch.losses()).toBe(1);
	}, 30_000);

	it("counts only observations that answered, and still drains once when late answers arrive together", async () => {
		// given: every stat is slower than the poll interval, the race a loaded CI runner produces (#2351)
		let release = (): void => {};
		probe.held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const watch = await watchRemovedEndpoint();

		// when: six polls fire before any of their observations has answered
		for (let poll = 0; poll < 6; poll++) await vi.advanceTimersByTimeAsync(SUPERSESSION_POLL_MS);

		// then: nothing unanswered counts as absence yet
		expect(watch.losses()).toBe(0);

		// when: the held observations all answer at once
		release();
		await settleObservations();

		// then: the loss is reported exactly once, however many absent answers arrive
		expect(watch.losses()).toBe(1);
	}, 30_000);
});
