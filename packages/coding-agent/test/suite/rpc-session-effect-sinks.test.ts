import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { EffectStatus } from "../../src/modes/rpc/effect-record.ts";
import {
	drainSessionEffects,
	installSessionEffectSink,
	noteSessionEffect,
	type SessionEffectSink,
} from "../../src/modes/rpc/session-effect-status.ts";

const status = (effectId: string): EffectStatus => ({
	effectId,
	kind: "abort",
	state: "accepted",
	durableSessionId: "durable-1",
});
const fakeSession = (): AgentSession => ({}) as AgentSession;
const microtask = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

function recordingSink(owned: Set<AgentSession>): SessionEffectSink & { delivered: string[] } {
	const delivered: string[] = [];
	return {
		delivered,
		owns: (session) => owned.has(session),
		flush: (_session, statuses) => delivered.push(...statuses.map((entry) => entry.effectId)),
	};
}

describe("effect_status sinks", () => {
	it("holds nothing for a session no host owns (classic stdio, worker isolate, replaced session)", async () => {
		const orphan = fakeSession();
		for (let index = 0; index < 1000; index++) noteSessionEffect(orphan, status(`e${index}`));
		await microtask();
		expect(drainSessionEffects(orphan)).toEqual([]);
	});

	it("delivers each session's transitions to the host that owns it, even with two hosts installed", async () => {
		const first = fakeSession();
		const second = fakeSession();
		const firstSink = recordingSink(new Set([first]));
		const secondSink = recordingSink(new Set([second]));
		const uninstallFirst = installSessionEffectSink(firstSink);
		const uninstallSecond = installSessionEffectSink(secondSink);
		try {
			noteSessionEffect(first, status("a"));
			noteSessionEffect(second, status("b"));
			await microtask();
			expect(firstSink.delivered).toEqual(["a"]);
			expect(secondSink.delivered).toEqual(["b"]);
		} finally {
			uninstallFirst();
			uninstallSecond();
		}
	});

	it("stops holding and delivering once a host uninstalls its sink", async () => {
		const session = fakeSession();
		const sink = recordingSink(new Set([session]));
		const uninstall = installSessionEffectSink(sink);
		noteSessionEffect(session, status("held"));
		uninstall();
		await microtask();
		noteSessionEffect(session, status("after"));
		await microtask();
		expect(sink.delivered).toEqual([]);
		expect(drainSessionEffects(session)).toEqual([]);
	});
});
