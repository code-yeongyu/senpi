import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type JobWidgetAuthor,
	type JobWidgetEntryState,
	JobWidgetRegistry,
	type JobWidgetObfuscator,
	type JobWidgetState,
	secretOutputObfuscator,
	TextTap,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { UNMATCHED_SPEC } from "./author-support.ts";
import { KEY_FORMS, type Key, leakedSlices, makeKey } from "./key-fixtures.ts";

// Security contract: clients persist job_widget_state, so no credential a job prints may reach it.
const TOKENS: readonly (readonly [string, string, string])[] = [
	["GitHub token", `ghp_${"A1b2C3d4E5".repeat(4)}`, "deploy with"],
	["OpenAI project key", `sk-proj-${"Zx9Yw8Vu7T".repeat(4)}`, "using key"],
	["AWS access key id", "AKIAIOSFODNN7EXAMPLE", "aws id"],
	["bearer token", "abcDEF1234567890xyzTOKEN", "Authorization: Bearer"],
];

/** Every line is the newest at some point, so it reaches the stage and the text block. */
const LINE_SPEC = {
	title: "deploy",
	rules: [{ from: "out", match: "^(?P<line>.+)$", text: "line" }],
	blocks: [{ kind: "text", field: "line" }],
	stage: "line",
};

const AUTHORS: readonly (readonly [JobWidgetEntryState, () => JobWidgetAuthor])[] = [
	["pending", () => () => new Promise<unknown>(() => {})],
	["fallback", () => async () => UNMATCHED_SPEC],
	["live", () => async () => LINE_SPEC],
];

describe("job widget views are redacted before they are published", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe.each(AUTHORS)("%s", (state, makeAuthor) => {
		it.each(TOKENS)("never carries a printed %s", async (_name, token, prefix) => {
			const sent: JobWidgetState[] = [];
			const registry = new JobWidgetRegistry({
				sessionId: "session_1",
				author: makeAuthor(),
				publish: (published) => sent.push(published),
				limits: { authorAfterMs: 0 },
			});
			const tap = new TextTap("out", "command output");
			const handle = registry.add({
				id: "bash_1",
				kind: "bash",
				sources: [tap],
				brief: { command: `./deploy.sh ${prefix} ${token}` },
				startedAtMs: Date.now(),
			});
			tap.append(`step 1 rps=40\nstep 2 rps=44\nstep 3 rps=51\n${prefix} ${token}\n`);
			handle.notify();
			await vi.advanceTimersByTimeAsync(3000);

			const last = sent.at(-1)?.jobs[0];
			expect(last?.state).toBe(state);
			const published = JSON.stringify([...sent, registry.state()]);
			expect(published).not.toContain(token);
			expect(last?.view?.stage).toBe(`${prefix} [REDACTED]`);
			if (state === "live") expect(last?.view?.blocks).toEqual([{ kind: "text", text: `${prefix} [REDACTED]` }]);
			else expect(last?.view?.title).toContain("[REDACTED]");
			registry.dispose();
		});
	});
});

const PRE = ["step 1 rps=40", "step 2 rps=44", "step 3 rps=51"];
const POST = "step 4 rps=52";

interface KeyStream {
	readonly name: string;
	/** Appends the job's output, refreshing in between; returns the tap. */
	readonly print: (key: Key, eol: string, refresh: (tap: TextTap) => Promise<void>) => Promise<TextTap>;
}

const text = (lines: readonly string[], eol: string): string => lines.map((line) => line + eol).join("");

/** How the key reaches the widget: one chunk, two refreshes, past a gap the tap dropped, or still open. */
const KEY_STREAMS: readonly KeyStream[] = [
	{
		name: "whole key in one chunk",
		print: async (key, eol, refresh) => {
			const tap = new TextTap("out", "command output");
			tap.append(text([...PRE, ...key.lines, POST], eol));
			await refresh(tap);
			return tap;
		},
	},
	{
		name: "key across two refreshes",
		print: async (key, eol, refresh) => {
			const tap = new TextTap("out", "command output");
			const split = key.bodyStart + 5;
			tap.append(text([...PRE, ...key.lines.slice(0, split)], eol));
			await refresh(tap);
			tap.append(text([...key.lines.slice(split), POST], eol));
			await refresh(tap);
			return tap;
		},
	},
	{
		name: "BEGIN line dropped by the tap",
		print: async (key, eol, refresh) => {
			const kept = text([...key.lines.slice(key.bodyStart + 3), POST], eol);
			const tap = new TextTap("out", "command output", kept.length + 10);
			tap.append(text(PRE, eol));
			await refresh(tap);
			tap.append(text([...key.lines, POST], eol));
			await refresh(tap);
			return tap;
		},
	},
	{
		name: "END line not printed yet",
		print: async (key, eol, refresh) => {
			const tap = new TextTap("out", "command output");
			tap.append(text([...PRE, ...key.lines.slice(0, key.bodyStart + key.body.length)], eol));
			await refresh(tap);
			return tap;
		},
	},
	{
		name: "BEGIN line dropped and the job ends before END",
		print: async (key, eol, refresh) => {
			const bodyEnd = key.bodyStart + key.body.length;
			const kept = text(key.lines.slice(key.bodyStart + 3, bodyEnd), eol);
			const tap = new TextTap("out", "command output", kept.length + 10);
			tap.append(text(PRE, eol));
			await refresh(tap);
			tap.append(text(key.lines.slice(0, bodyEnd), eol));
			tap.close();
			await refresh(tap);
			return tap;
		},
	},
	{
		name: "gap ends inside the BEGIN marker line and the job ends before END",
		print: async (key, eol, refresh) => {
			const bodyEnd = key.bodyStart + key.body.length;
			const kept = text(key.lines.slice(0, bodyEnd), eol).length - 5;
			const tap = new TextTap("out", "command output", kept);
			tap.append(text(PRE, eol));
			await refresh(tap);
			tap.append(text(key.lines.slice(0, bodyEnd), eol));
			tap.close();
			await refresh(tap);
			return tap;
		},
	},
];

const SETTINGS: readonly (readonly [string, JobWidgetObfuscator | undefined])[] = [
	["redaction off", undefined],
	["redaction on", secretOutputObfuscator],
];

const KEY_CASES = KEY_FORMS.flatMap((form, formIndex) =>
	KEY_STREAMS.flatMap((stream) =>
		(["LF", "CRLF"] as const).flatMap((ending) =>
			SETTINGS.map(
				([setting, obfuscate]) =>
					[
						`${form.name} / ${stream.name} / ${ending} / ${setting}`,
						form,
						formIndex,
						stream,
						ending,
						obfuscate,
					] as const,
			),
		),
	),
);

describe("job widget views never carry a private key", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe.each(AUTHORS)("%s", (state, makeAuthor) => {
		it.each(KEY_CASES)("%s", async (_name, form, formIndex, stream, ending, obfuscate) => {
			const key = makeKey(form, formIndex + 101);
			const eol = ending === "CRLF" ? "\r\n" : "\n";
			const sent: JobWidgetState[] = [];
			const registry = new JobWidgetRegistry({
				sessionId: "session_1",
				author: makeAuthor(),
				publish: (published) => sent.push(published),
				limits: { authorAfterMs: 0 },
				...(obfuscate === undefined ? {} : { obfuscate }),
			});
			let handle: ReturnType<JobWidgetRegistry["add"]> | undefined;
			await stream.print(key, eol, async (tap) => {
				handle ??= registry.add({
					id: "bash_1",
					kind: "bash",
					sources: [tap],
					brief: { command: `install -m 600 /dev/stdin id_key <<'EOF'${eol}${text(key.lines, eol)}EOF` },
					startedAtMs: Date.now(),
				});
				handle.notify();
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(sent.at(-1)?.jobs[0]?.state).toBe(state);
			const published = JSON.stringify([...sent, registry.state()]);
			expect(leakedSlices(published, key.body)).toEqual([]);
			registry.dispose();
		});
	});
});
