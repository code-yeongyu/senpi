import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
	BackgroundRestoreResult,
	MonitorRestoreResult,
	RestoreDigest,
} from "../../src/core/extensions/builtin/terminal/restore.ts";
import {
	buildRestoreDigest,
	createDigestSlot,
	deliverRestoreDigest,
	isActionable,
	RESTORE_DIGEST_CUSTOM_TYPE,
	type RestoreDigestDetails,
	type RestoreDigestMessage,
	registerRestoreDigestRenderer,
} from "../../src/core/extensions/builtin/terminal/restore-digest.ts";
import type { MessageRenderer } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function digestOf(
	results: readonly MonitorRestoreResult[],
	backgroundSessions: readonly BackgroundRestoreResult[] = [],
	downtimeMs = 3_900_000,
): RestoreDigest {
	const digest: RestoreDigest = {
		restored: 0,
		lost: 0,
		expired: 0,
		muted: 0,
		completed: 0,
		attachedElsewhere: 0,
		storeError: false,
		results,
		backgroundSessions,
		downtimeMs,
	};
	for (const result of results) digest[result.outcome] += 1;
	digest.lost += backgroundSessions.length;
	return digest;
}

const MIXED_RESULTS: readonly MonitorRestoreResult[] = [
	{
		monitorId: "mon_tick",
		description: "tick loop",
		kind: "command",
		outcome: "restored",
		command: "while true; do echo tick; sleep 1; done",
		orphan: { pid: 4242, action: "killed" },
	},
	{ monitorId: "mon_artifact", description: "artifact file", kind: "file", outcome: "restored", path: "/tmp/a.log" },
	{
		monitorId: "mon_missing",
		description: "missing script",
		kind: "command",
		outcome: "lost",
		command: "sh /tmp/nope.sh",
		reason: "exited with code 127 during the grace window",
	},
	{ monitorId: "mon_quiet", description: "muted watch", kind: "command", outcome: "muted", command: "tail -f x" },
	{ monitorId: "mon_done", description: "finished watch", kind: "command", outcome: "completed", command: "true" },
	{ monitorId: "mon_old", description: "stale watch", kind: "file", outcome: "expired", path: "/tmp/old.log" },
];
const MIXED_BACKGROUND: readonly BackgroundRestoreResult[] = [
	{ id: "bash_1", command: "npm run dev", outcome: "running", pid: 777 },
	{ id: "bash_2", command: "make build", outcome: "exited" },
];
const MONITOR_IDS = MIXED_RESULTS.map((result) => result.monitorId);
const LOST_REASON = "exited with code 127 during the grace window";

function mixedMessage(): RestoreDigestMessage {
	return buildRestoreDigest(digestOf(MIXED_RESULTS, MIXED_BACKGROUND), { generation: 2, outcome: "decided" });
}

function quietMessage(): RestoreDigestMessage {
	const quiet: MonitorRestoreResult = {
		monitorId: "mon_calm",
		description: "calm file",
		kind: "file",
		outcome: "restored",
		path: "/tmp/calm.log",
	};
	const exited: BackgroundRestoreResult = { id: "bash_3", command: "make", outcome: "exited" };
	return buildRestoreDigest(digestOf([quiet], [exited]), { generation: 2, outcome: "decided" });
}

interface SentCall {
	readonly message: unknown;
	readonly options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined;
}

function createFakePi() {
	const sent: SentCall[] = [];
	const renderers = new Map<string, MessageRenderer<RestoreDigestDetails>>();
	return {
		sent,
		renderers,
		sendMessage(message: unknown, options?: SentCall["options"]): void {
			sent.push({ message, options });
		},
		registerMessageRenderer(customType: string, renderer: MessageRenderer<RestoreDigestDetails>): void {
			renderers.set(customType, renderer);
		},
	};
}

function createFakeCtx(model: unknown) {
	return { model, ui: { notify: vi.fn<(message: string, type?: "info" | "warning" | "error") => void>() } };
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("restore digest message", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("(a) names every monitor exactly once with the lost reason and the downtime bound", () => {
		const message = mixedMessage();
		expect(message.customType).toBe(RESTORE_DIGEST_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		expect(message.content.startsWith("Terminal state after restart")).toBe(true);
		for (const id of MONITOR_IDS) expect(occurrences(message.content, id)).toBe(1);
		expect(message.content).toContain(LOST_REASON);
		expect(message.content).toContain("offline up to 1h 5m");
		expect(message.content).toContain("bash_1");
		expect(message.content).toContain("777");
		expect(message.details.monitors.map((monitor) => monitor.monitorId)).toEqual(MONITOR_IDS);
		expect(message.details.downtimeIsUpperBound).toBe(true);
		expect(message.details.generation).toBe(2);

		const deferred = buildRestoreDigest(digestOf([]), { generation: 2, outcome: "deferred", holderPid: 4321 });
		expect(deferred.details.holder).toEqual({ pid: 4321 });
		expect(deferred.content).toContain("4321");
	});

	it("(b) the slot delivers exactly one decided message per generation", () => {
		const slot = createDigestSlot();
		const deferred = buildRestoreDigest(digestOf([]), { generation: 2, outcome: "deferred", holderPid: 4321 });
		const decided = mixedMessage();
		const delivered: RestoreDigestMessage[] = [];
		const deliver = (message: RestoreDigestMessage) => {
			delivered.push(message);
			return true;
		};

		slot.set(deferred);
		slot.set(decided);
		expect(slot.flush(deliver)).toBe(true);
		expect(delivered).toEqual([decided]);

		slot.set(quietMessage());
		expect(slot.flush(deliver)).toBe(false);
		expect(delivered).toEqual([decided]);
		expect(slot.pending()).toBeUndefined();
	});

	it("(c) stays pending while no model is bound and delivers once a model is", () => {
		const pi = createFakePi();
		const ctx = createFakeCtx(undefined);
		const slot = createDigestSlot();
		const message = mixedMessage();
		slot.set(message);

		expect(slot.flush((pendingMessage) => deliverRestoreDigest(pi, ctx, pendingMessage))).toBe(false);
		expect(pi.sent).toHaveLength(0);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(slot.pending()).toBe(message);

		ctx.model = { id: "fake-model" };
		expect(slot.flush((pendingMessage) => deliverRestoreDigest(pi, ctx, pendingMessage))).toBe(true);
		expect(slot.flush((pendingMessage) => deliverRestoreDigest(pi, ctx, pendingMessage))).toBe(false);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.message).toBe(message);
	});

	it("(d) wakes the agent only when the digest is actionable", () => {
		expect(isActionable(digestOf(MIXED_RESULTS, MIXED_BACKGROUND))).toBe(true);
		expect(isActionable(digestOf([], [{ id: "bash_1", command: "x", outcome: "running", pid: 1 }]))).toBe(true);
		const orphanOnly = MIXED_RESULTS.slice(0, 1);
		expect(isActionable(digestOf(orphanOnly))).toBe(true);

		const pi = createFakePi();
		deliverRestoreDigest(pi, createFakeCtx({}), mixedMessage());
		deliverRestoreDigest(pi, createFakeCtx({}), quietMessage());
		expect(pi.sent.map((call) => call.options)).toEqual([
			{ triggerTurn: true, deliverAs: "followUp" },
			{ triggerTurn: false, deliverAs: "nextTurn" },
		]);
	});

	it("(e) notifies the user once with the sentence", () => {
		const pi = createFakePi();
		const ctx = createFakeCtx({});
		const message = mixedMessage();
		expect(deliverRestoreDigest(pi, ctx, message)).toBe(true);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(message.content, "info");
	});

	it("(f) the renderer shows every monitor id and every lost reason", () => {
		const pi = createFakePi();
		registerRestoreDigestRenderer(pi);
		const renderer = pi.renderers.get(RESTORE_DIGEST_CUSTOM_TYPE);
		expect(renderer).toBeDefined();
		if (renderer === undefined) return;
		const message = mixedMessage();
		const component = renderer(
			{ role: "custom", timestamp: 0, ...message },
			{ expanded: false, outputPad: 0 },
			theme,
		);
		const text = (component?.render(200) ?? []).join("\n").replace(ANSI_PATTERN, "");
		for (const id of MONITOR_IDS) expect(text).toContain(id);
		expect(text).toContain(LOST_REASON);
		expect(text).toContain("bash_1");
	});
});
