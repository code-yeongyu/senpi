import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type JobWidgetAuthor,
	type JobWidgetEntryState,
	type JobWidgetObfuscator,
	JobWidgetRegistry,
	type JobWidgetSourceSample,
	type JobWidgetState,
	PRIVATE_KEY_MARKER,
	secretOutputObfuscator,
	TextTap,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { controllerFor, FakeJob, RPS_SPEC, scriptedAuthor } from "./author-support.ts";
import { KEY_FORMS, type Key, leakedSlices, makeKey } from "./key-fixtures.ts";

// Security contract (P4 review): a private key printed through a log that puts a prefix before
// every line (`docker logs -t`, `kubectl logs --timestamps`, a `[pod] ` tag) is held and redacted
// like a bare one, wherever the window cuts it; ordinary prefixed lines and hex hashes are kept.

const two = (value: number): string => String(value % 60).padStart(2, "0");

/** A per-line prefix: line `index` of the job's output gets `prefix(index)` before it. */
const PREFIXES: readonly (readonly [string, (index: number) => string])[] = [
	// RFC 3339 nano with trailing zeros trimmed, so the fraction's length changes from line to line.
	[
		"docker logs -t",
		(index) => `2026-10-28T12:00:${two(index)}.${["5", "25", "125", "1234", "98765432", "123456789"][index % 6]}Z `,
	],
	[
		"kubectl logs --timestamps",
		(index) => `2026-10-28T12:${two(index)}:07.${String(100_000_000 + index * 7919).padStart(9, "0")}Z `,
	],
	["[pod] tag", () => "[pod/api-7d9f8b-xk2lp/app] "],
	["ISO timestamp", (index) => `2026-10-28T12:00:${two(index)}.${String(index * 37).padStart(3, "0")}Z `],
];

const prefixAll = (lines: readonly string[], prefix: (index: number) => string, from = 0): string[] =>
	lines.map((line, index) => prefix(from + index) + line);

const PRE = ["req 1 rps=40", "req 2 rps=44", "req 3 rps=51"];
const POST = "req 4 rps=52";

const SETTINGS: readonly (readonly [string, JobWidgetObfuscator | undefined])[] = [
	["redaction off", undefined],
	["redaction on", secretOutputObfuscator],
];

interface Window {
	readonly head: readonly string[];
	readonly tail: readonly string[];
}

/** Where the sample windows cut the prefixed key; `p` prefixes from a line index of the output. */
const PLACEMENTS: readonly (readonly [string, (key: Key, p: (index: number) => string) => Window])[] = [
	[
		"BEGIN line in the window",
		(key, p) => ({ head: prefixAll([...PRE, ...key.lines, "after"], p), tail: prefixAll([POST], p, 90) }),
	],
	[
		"BEGIN line cut, window ends in the body",
		(key, p) => ({
			head: prefixAll(PRE, p),
			tail: prefixAll([POST, ...key.lines.slice(key.bodyStart + 2, key.bodyStart + key.body.length)], p, 40),
		}),
	],
	[
		"BEGIN line cut, only the END line carries a marker",
		(key, p) => ({ head: prefixAll(PRE, p), tail: prefixAll([...key.lines.slice(key.bodyStart + 2), POST], p, 40) }),
	],
];

function sample(window: Window): JobWidgetSourceSample {
	const head = window.head.filter((line) => line.trim().length > 0);
	const tail = window.tail.filter((line) => line.trim().length > 0);
	return { id: "out", label: "docker logs -t api", size: 8192, lines: head.length + tail.length + 40, head, tail };
}

const AUTHOR_CASES = KEY_FORMS.flatMap((form, formIndex) =>
	PREFIXES.flatMap(([prefixName, prefix]) =>
		PLACEMENTS.flatMap(([placementName, window]) =>
			SETTINGS.map(
				([setting, obfuscate]) =>
					[
						`${form.name} / ${prefixName} / ${placementName} / ${setting}`,
						form,
						formIndex,
						prefix,
						window,
						obfuscate,
					] as const,
			),
		),
	),
);

describe("job widget author: prefixed private-key bodies never reach the author", () => {
	it.each(AUTHOR_CASES)("%s", async (_name, form, formIndex, prefix, window, obfuscate) => {
		const key = makeKey(form, formIndex + 201);
		const { author, requests } = scriptedAuthor(RPS_SPEC);
		const { controller } = controllerFor(author, {}, obfuscate);
		const job = new FakeJob("bg_1", { kind: "bash", command: "docker logs -t api" });
		job.sources = [sample(window(key, prefix))];

		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "installed" });
		expect(requests).toHaveLength(1);
		expect(leakedSlices(JSON.stringify(requests), key.body)).toEqual([]);
		const source = requests[0]?.sources[0];
		const lines = [...(source?.head ?? []), ...(source?.tail ?? [])].join("\n");
		expect(lines).toContain(PRIVATE_KEY_MARKER);
		expect(source?.head).toContain(`${prefix(0)}req 1 rps=40`);
	});
});

const HEX = "3f786850e387550fdab836ed7e6dc881de23001b";

/** Ordinary output that must pass unredacted, even right at a window cut. */
const ORDINARY: readonly (readonly [string, readonly string[]])[] = [
	["40-char hex hash", [HEX]],
	["upper-case hex hash", [HEX.toUpperCase()]],
	["sha256 digest", [`Pulling fs layer sha256:${HEX}${HEX.slice(0, 24)}`]],
	["run of commit hashes", [`commit ${HEX}`, `commit ${HEX.split("").reverse().join("")}`, `commit ${HEX}`]],
	["request log line", ["GET /api/v1/users 200 12ms"]],
	["worker start line", ["Started worker pid=48213 queue=default"]],
];

const NEGATIVE_PREFIXES: readonly (readonly [string, (index: number) => string])[] = [
	["no prefix", () => ""],
	...PREFIXES,
];

const NEGATIVE_CASES = NEGATIVE_PREFIXES.flatMap(([prefixName, prefix]) =>
	ORDINARY.map(([name, lines]) => [`${name} / ${prefixName}`, prefix, lines] as const),
);

describe("job widget author: ordinary prefixed output is kept", () => {
	it.each(NEGATIVE_CASES)("%s", async (_name, prefix, ordinary) => {
		const { author, requests } = scriptedAuthor(RPS_SPEC);
		const { controller } = controllerFor(author);
		const job = new FakeJob("bg_1", { kind: "bash", command: "docker logs -t api" });
		// Before the head's cut, first after it, and last before the tail's cut.
		const head = prefixAll([...PRE, ...ordinary], prefix);
		const tail = prefixAll([...ordinary, POST, ...ordinary], prefix, 50);
		job.sources = [sample({ head, tail })];

		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "installed" });
		expect(requests[0]?.sources[0]?.head).toEqual(head);
		expect(requests[0]?.sources[0]?.tail).toEqual(tail);
	});
});

/** Every line is the newest at some point, so it reaches the stage and the text block. */
const LINE_SPEC = {
	title: "logs",
	rules: [{ from: "out", match: "^(?P<line>.+)$", text: "line" }],
	blocks: [{ kind: "text", field: "line" }],
	stage: "line",
};

const AUTHORS: readonly (readonly [JobWidgetEntryState, () => JobWidgetAuthor])[] = [
	["pending", () => () => new Promise<unknown>(() => {})],
	["live", () => async () => LINE_SPEC],
];

const text = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join("");

type Refresh = (tap: TextTap) => Promise<void>;

/** How the prefixed key reaches the widget: whole, past a gap the tap dropped, with or without its END line. */
const STREAMS: readonly (readonly [
	string,
	(key: Key, p: (index: number) => string, refresh: Refresh) => Promise<void>,
])[] = [
	[
		"BEGIN line in the window",
		async (key, p, refresh) => {
			const tap = new TextTap("out", "command output");
			tap.append(text(prefixAll([...PRE, ...key.lines, POST], p)));
			await refresh(tap);
		},
	],
	[
		"BEGIN line dropped, job ends before END",
		async (key, p, refresh) => {
			const bodyEnd = key.bodyStart + key.body.length;
			const all = prefixAll([...PRE, ...key.lines.slice(0, bodyEnd)], p);
			const kept = text(all.slice(PRE.length + key.bodyStart + 3));
			const tap = new TextTap("out", "command output", kept.length + 10);
			tap.append(text(all.slice(0, PRE.length)));
			await refresh(tap);
			tap.append(text(all.slice(PRE.length)));
			tap.close();
			await refresh(tap);
		},
	],
	[
		"BEGIN line dropped, only the END line carries a marker",
		async (key, p, refresh) => {
			const all = prefixAll([...PRE, ...key.lines, POST], p);
			const kept = text(all.slice(PRE.length + key.bodyStart + 3));
			const tap = new TextTap("out", "command output", kept.length + 10);
			tap.append(text(all.slice(0, PRE.length)));
			await refresh(tap);
			tap.append(text(all.slice(PRE.length)));
			await refresh(tap);
		},
	],
];

const VIEW_CASES = KEY_FORMS.flatMap((form, formIndex) =>
	PREFIXES.flatMap(([prefixName, prefix]) =>
		STREAMS.map(
			([streamName, stream]) =>
				[`${form.name} / ${prefixName} / ${streamName}`, form, formIndex, prefix, stream] as const,
		),
	),
);

function registryFor(makeAuthor: () => JobWidgetAuthor) {
	const sent: JobWidgetState[] = [];
	const registry = new JobWidgetRegistry({
		sessionId: "session_1",
		author: makeAuthor(),
		publish: (published) => sent.push(published),
		limits: { authorAfterMs: 0 },
	});
	let handle: ReturnType<JobWidgetRegistry["add"]> | undefined;
	const refresh: Refresh = async (tap) => {
		handle ??= registry.add({
			id: "bash_1",
			kind: "bash",
			sources: [tap],
			brief: { command: "docker logs -t api" },
			startedAtMs: Date.now(),
		});
		handle.notify();
		await vi.advanceTimersByTimeAsync(3000);
	};
	return { registry, sent, refresh };
}

describe("job widget views: prefixed private-key bodies are never published", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe.each(AUTHORS)("%s", (state, makeAuthor) => {
		it.each(VIEW_CASES)("%s", async (_name, form, formIndex, prefix, stream) => {
			const key = makeKey(form, formIndex + 301);
			const { registry, sent, refresh } = registryFor(makeAuthor);
			await stream(key, prefix, refresh);

			expect(sent.at(-1)?.jobs[0]?.state).toBe(state);
			expect(leakedSlices(JSON.stringify([...sent, registry.state()]), key.body)).toEqual([]);
			registry.dispose();
		});

		it.each(NEGATIVE_CASES)("keeps %s right after a gap the tap dropped", async (_name, prefix, ordinary) => {
			const { registry, sent, refresh } = registryFor(makeAuthor);
			const lines = prefixAll(ordinary, prefix, 60);
			const pre = text(prefixAll(PRE, prefix));
			const capacity = Math.max(pre.length, text(lines).length) + 10;
			const tap = new TextTap("out", "command output", capacity);
			tap.append(pre);
			await refresh(tap);
			// The tap drops text inside this line, so the ordinary lines are the first whole ones after the gap.
			tap.append(text([`${prefix(30)}filler ${"x".repeat(capacity)}`, ...lines]));
			tap.close();
			await refresh(tap);

			const published = JSON.stringify([...sent, registry.state()]);
			expect(sent.at(-1)?.jobs[0]?.view?.stage).toBe(lines.at(-1));
			expect(published).not.toContain(PRIVATE_KEY_MARKER);
			registry.dispose();
		});
	});
});
