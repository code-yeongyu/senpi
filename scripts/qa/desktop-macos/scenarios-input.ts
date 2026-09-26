import type { AgentSession } from "./agent.ts";
import {
	closeKeySink,
	type KeySink,
	openKeySink,
	openTextEdit,
	quitTextEdit,
	settle,
	textEditSelection,
	textEditText,
} from "./fixtures.ts";
import { focusSnapshot, sameJson, topmostAt } from "./observer.ts";
import {
	clickCode,
	keyLands,
	onWindow,
	type RunOptions,
	type ScenarioResult,
	toolError,
	warmUp,
	withSession,
} from "./scenario.ts";

/** TextEdit documents opened unfocused, then a Terminal key sink made frontmost; torn down afterwards. */
async function withDesk<T>(docs: Readonly<Record<string, string>>, use: (sink: KeySink) => Promise<T>): Promise<T> {
	await quitTextEdit();
	for (const [name, text] of Object.entries(docs)) await openTextEdit(name, text);
	const sink = await openKeySink(Object.keys(docs).join("+"));
	try {
		return await use(sink);
	} finally {
		await closeKeySink(sink);
		await quitTextEdit();
	}
}

export async function backgroundClickKeepsFocus(options: RunOptions): Promise<ScenarioResult> {
	const doc = "qa-click.txt";
	const delivery = options.forceForeground ? "foreground" : "background";
	return withDesk({ [doc]: "senpi qa click target\nsecond line\n" }, (sink) =>
		withSession({}, async (session) => {
			const warm = await warmUp(session, doc);
			const before = await focusSnapshot();
			const selectionBefore = await textEditSelection(doc);
			const clicked = await session.call(clickCode(doc, delivery));
			const after = await focusSnapshot();
			const selectionAfter = await textEditSelection(doc);
			const keystroke = await keyLands(sink);
			const focusUnchanged = sameJson(before, after);
			const selectionChanged = !sameJson(selectionBefore, selectionAfter);
			const facts = {
				delivery,
				warmUpError: toolError(warm),
				clickError: toolError(clicked),
				observer: { before, after },
				focusUnchanged,
				textEditSelection: { before: selectionBefore, after: selectionAfter },
				selectionChanged,
				keystroke,
			};
			const pass = !warm.isError && !clicked.isError && focusUnchanged && selectionChanged && keystroke.landed;
			return { scenario: "background-click-keeps-focus", pass, facts };
		}),
	);
}

/** Types into the sole window and waits until TextEdit's own dictionary shows the whole text. */
async function typeInto(session: AgentSession, doc: string, text: string, delivery: string) {
	const typed = await session.call(
		onWindow(doc, `await w.type(${JSON.stringify(text)}, { delivery: "${delivery}" });`),
	);
	const textAfter = typed.isError
		? await textEditText(doc)
		: await settle(
				"typed text",
				() => textEditText(doc),
				(value) => value === text,
			).catch(() => textEditText(doc));
	return { typed, textAfter };
}

export async function backgroundTypeSoleWindow(): Promise<ScenarioResult> {
	const doc = "qa-type.txt";
	// Digits only: TextEdit's text substitutions (auto-capitalization, smart punctuation) leave them alone.
	const text = "31415926535";
	return withDesk({ [doc]: "" }, (sink) =>
		withSession({}, async (session) => {
			const warm = await warmUp(session, doc);
			const before = await focusSnapshot();
			const { typed, textAfter } = await typeInto(session, doc, text, "background");
			const after = await focusSnapshot();
			const keystroke = await keyLands(sink);
			const focusUnchanged = sameJson(before, after);
			const facts = {
				warmUpError: toolError(warm),
				typeError: toolError(typed),
				observer: { before, after },
				focusUnchanged,
				textEditText: textAfter,
				keystroke,
			};
			const pass = !warm.isError && !typed.isError && focusUnchanged && textAfter === text && keystroke.landed;
			return { scenario: "background-type-sole-window", pass, facts };
		}),
	);
}

export async function backgroundTypeMultiwindowRefused(): Promise<ScenarioResult> {
	const docs = { "qa-multi-a.txt": "alpha\n", "qa-multi-b.txt": "beta\n" };
	return withDesk(docs, () =>
		withSession({}, async (session) => {
			const read = async () => ({
				a: await textEditText("qa-multi-a.txt"),
				b: await textEditText("qa-multi-b.txt"),
			});
			const before = await read();
			const typed = await session.call(onWindow("qa-multi-a.txt", `await w.type("x", { delivery: "background" });`));
			const after = await read();
			const audit = session.auditLog().filter((record) => record.action === "typeText");
			const refused = typed.isError && audit.length === 1 && audit[0]?.code === "BackgroundUnavailable";
			const facts = { typeError: toolError(typed), auditTypeText: audit, refused, textEdit: { before, after } };
			return { scenario: "background-type-multiwindow-refused", pass: refused && sameJson(before, after), facts };
		}),
	);
}

/**
 * A foreground click: it activates TextEdit, clicks, and must restore the Terminal sink. A click leaves the
 * document clean on purpose: on this host TextEdit's deactivation autosave of an edited document deadlocks its
 * main thread (reproduced with plain System Events typing, no engine involved), which would hang every probe.
 */
export async function foregroundRestores(): Promise<ScenarioResult> {
	const doc = "qa-foreground.txt";
	const restored = async () => {
		const { frontmostApp, focusedWindow, cursor, zOrder } = await focusSnapshot();
		return { frontmostApp, focusedWindow, cursor, frontWindow: zOrder[0] ?? null };
	};
	return withDesk({ [doc]: "senpi qa foreground target\nsecond line\n" }, (sink) =>
		withSession({}, async (session) => {
			const before = await restored();
			const selectionBefore = await textEditSelection(doc);
			// Where the click point sits in the z-order before foreground delivery raises the target.
			const topmostBefore = await topmostAt(doc, 0.5, 0.8);
			const clicked = await session.call(clickCode(doc, "foreground"));
			const after = await restored();
			const selectionAfter = await textEditSelection(doc);
			const keystroke = await keyLands(sink);
			const audit = session.auditLog().filter((record) => record.action === "click");
			const focusRestored = audit.length === 1 && audit[0]?.focusRestored === true;
			const observerRestored = sameJson(before, after);
			const selectionChanged = !sameJson(selectionBefore, selectionAfter);
			const facts = {
				clickError: toolError(clicked),
				topmostBefore,
				observer: { before, after },
				observerRestored,
				auditClick: audit,
				focusRestored,
				textEditSelection: { before: selectionBefore, after: selectionAfter },
				selectionChanged,
				keystroke,
			};
			const pass = !clicked.isError && observerRestored && focusRestored && selectionChanged && keystroke.landed;
			return { scenario: "foreground-restores", pass, facts };
		}),
	);
}
