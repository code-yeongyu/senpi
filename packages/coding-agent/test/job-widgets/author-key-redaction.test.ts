import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

import {
	createModelJobWidgetAuthor,
	type JobWidgetObfuscator,
	type JobWidgetSourceSample,
	PRIVATE_KEY_MARKER,
	secretOutputObfuscator,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { controllerFor, FakeJob, RPS_SPEC, scriptedAuthor, UNMATCHED_SPEC } from "./author-support.ts";
import { KEY_FORMS, type Key, leakedSlices, makeKey } from "./key-fixtures.ts";

// Security contract (P2 review): a private key a job prints, or names in its brief, label or retry
// text, never reaches an author, whatever the session's secret setting and wherever the sample
// windows cut the key.

const WIDGET_MODEL: Model<Api> = {
	id: "widget-model",
	name: "Widget model",
	api: "openai-completions",
	provider: "job-widgets-test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4096,
};

const PRE = ["req 1 rps=40", "req 2 rps=44", "req 3 rps=51"];
const POST = "req 4 rps=52";

interface Placement {
	readonly name: string;
	readonly window: (key: Key) => { head: string[]; tail: string[] };
}

/** Where the sample windows cut the key; samples keep non-empty lines only. */
const PLACEMENTS: readonly Placement[] = [
	{ name: "whole key in the head", window: (key) => ({ head: [...PRE, ...key.lines, "after"], tail: [POST] }) },
	{
		name: "split across head and tail",
		window: (key) => ({
			head: [...PRE, ...key.lines.slice(0, key.bodyStart + 4)],
			tail: [...key.lines.slice(key.bodyStart + 4), POST],
		}),
	},
	{
		name: "BEGIN line in the unread middle",
		window: (key) => ({ head: PRE, tail: [...key.lines.slice(key.bodyStart + 2), POST] }),
	},
	{ name: "END line not printed yet", window: (key) => ({ head: PRE, tail: [POST, ...key.lines.slice(0, -2)] }) },
	{
		name: "both markers outside the windows",
		window: (key) => ({ head: PRE, tail: [POST, ...key.lines.slice(key.bodyStart + 2, -3)] }),
	},
];

const ENDINGS: readonly (readonly [string, string])[] = [
	["LF", ""],
	["CRLF", "\r"],
];

const SETTINGS: readonly (readonly [string, JobWidgetObfuscator | undefined])[] = [
	["redaction off", undefined],
	["redaction on", secretOutputObfuscator],
];

function sample(lines: { head: string[]; tail: string[] }, cr: string, label: string): JobWidgetSourceSample {
	const end = (list: string[]): string[] => list.filter((line) => line.trim().length > 0).map((line) => line + cr);
	const head = end(lines.head);
	const tail = end(lines.tail);
	return { id: "out", label, size: 4096, lines: head.length + tail.length + 40, head, tail };
}

const CASES = KEY_FORMS.flatMap((form, formIndex) =>
	PLACEMENTS.flatMap((placement) =>
		ENDINGS.flatMap(([ending, cr]) =>
			SETTINGS.map(
				([setting, obfuscate]) =>
					[
						`${form.name} / ${placement.name} / ${ending} / ${setting}`,
						form,
						formIndex,
						placement,
						cr,
						obfuscate,
					] as const,
			),
		),
	),
);

function leakyJob(key: Key, placement: Placement, cr: string): FakeJob {
	const keyText = key.lines.join(`${cr}\n`);
	const job = new FakeJob("bg_1", {
		kind: "bash",
		command: `printf '%s\\n' '${keyText}' > id_key && ./bench.sh`,
		intent: "benchmark with a deploy key",
	});
	job.sources = [sample(placement.window(key), cr, `./bench.sh ${keyText}`)];
	return job;
}

describe("job widget author: private keys never reach the author", () => {
	it.each(CASES)("%s", async (_name, form, formIndex, placement, cr, obfuscate) => {
		const key = makeKey(form, formIndex + 1);
		const echoed = { ...UNMATCHED_SPEC, title: key.lines.join("\n") };

		const scripted = scriptedAuthor(echoed, RPS_SPEC);
		const first = controllerFor(scripted.author, {}, obfuscate);
		expect(await first.controller.maybeRequest(leakyJob(key, placement, cr))).toMatchObject({ kind: "installed" });
		expect(scripted.requests).toHaveLength(2);
		expect(leakedSlices(JSON.stringify(scripted.requests), key.body)).toEqual([]);
		const [request, retry] = scripted.requests;
		expect(request?.brief.command).toContain(PRIVATE_KEY_MARKER);
		expect(request?.sources[0]?.label).toContain(PRIVATE_KEY_MARKER);
		expect([...(request?.sources[0]?.head ?? []), ...(request?.sources[0]?.tail ?? [])].join("\n")).toContain(
			PRIVATE_KEY_MARKER,
		);
		expect(request?.sources[0]?.head).toContain(`req 1 rps=40${cr}`);
		expect(retry?.rejected?.answer).toContain(PRIVATE_KEY_MARKER);

		const contexts: Context[] = [];
		const answers = [echoed, RPS_SPEC];
		const modelAuthor = createModelJobWidgetAuthor({
			resolveModel: () => WIDGET_MODEL,
			complete: async (_model, context) => {
				contexts.push(context);
				return fauxAssistantMessage(fauxToolCall("respond", answers.shift() ?? RPS_SPEC), {
					stopReason: "toolUse",
				});
			},
		});
		const second = controllerFor(modelAuthor, {}, obfuscate);
		expect(await second.controller.maybeRequest(leakyJob(key, placement, cr))).toMatchObject({ kind: "installed" });
		expect(contexts).toHaveLength(2);
		const prompt = JSON.stringify(contexts);
		expect(leakedSlices(prompt, key.body)).toEqual([]);
		expect(prompt).toContain("req 1 rps=40");
		expect(prompt).toContain(PRIVATE_KEY_MARKER);
	});

	it("feeds one session obfuscator per source, in order, never one per line", async () => {
		// A stateful obfuscator: hides every line between an opening and a closing line.
		let made = 0;
		const obfuscate: JobWidgetObfuscator = () => {
			made += 1;
			let hiding = false;
			return {
				push: (text) =>
					text
						.split(/(?<=\n)/)
						.map((line) => {
							if (line.startsWith("<<hide")) hiding = true;
							else if (line.startsWith("hide>>")) hiding = false;
							else if (hiding) return "<hidden>\n";
							return line;
						})
						.join(""),
				finish: () => "",
			};
		};
		const { author, requests } = scriptedAuthor(RPS_SPEC);
		const { controller } = controllerFor(author, {}, obfuscate);
		const job = new FakeJob("bg_1", { kind: "bash", command: "./bench.sh" });
		job.sources = [
			{
				id: "out",
				label: "out",
				size: 100,
				lines: 7,
				head: ["req 1 rps=40", "<<hide", "internal-value-1234", "hide>>", "req 2 rps=44"],
				tail: ["req 3 rps=51"],
			},
		];
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "installed" });
		expect(JSON.stringify(requests)).not.toContain("internal-value-1234");
		expect(requests[0]?.sources[0]?.head).toEqual(["req 1 rps=40", "<<hide", "<hidden>", "hide>>", "req 2 rps=44"]);
		// One per text (the command, the label) and one for the source's lines, not one per line.
		expect(made).toBe(3);
	});

	it("keeps ordinary output, including hash-shaped lines, that no END marker follows", async () => {
		const { author, requests } = scriptedAuthor(RPS_SPEC);
		const { controller } = controllerFor(author);
		const sha = "3f786850e387550fdab836ed7e6dc881de23001b";
		const job = new FakeJob("bg_1", { kind: "bash", command: "./bench.sh" });
		job.sources = [
			{
				id: "out",
				label: "out",
				size: 100,
				lines: 5,
				head: ["req 1 rps=40", sha, "req 2 rps=44"],
				tail: ["req 3 rps=51"],
			},
		];
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "installed" });
		expect(requests[0]?.sources[0]?.head).toEqual(["req 1 rps=40", sha, "req 2 rps=44"]);
		expect(requests[0]?.sources[0]?.tail).toEqual(["req 3 rps=51"]);
	});
});
