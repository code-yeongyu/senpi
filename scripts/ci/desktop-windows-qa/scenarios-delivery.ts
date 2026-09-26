// Delivery scenarios: foreground typing restores the previous front window, background PostMessage
// is refused for a toolkit class outside the matrix (Notepad) and lands without a focus change for
// one inside it (WPF). The target text and the foreground come from the independent observer.
import { type Engine, errorCode } from "./engine.ts";
import type { QaWindow } from "./fixtures.ts";
import { type Observation, observe, observeUntil, windowText } from "./observer.ts";
import { marker, type Scenario, type ScenarioContext, verdict, withEngine } from "./scenario-kit.ts";

async function bringToFront(engine: Engine, front: QaWindow, others: readonly string[]): Promise<Observation> {
	await engine.exec("raiseWindow", { windowId: front.id });
	return observeUntil([...others, front.id], (observation) => String(observation.foreground) === front.id);
}

interface Stage {
	readonly engine: Engine;
	readonly target: QaWindow;
	readonly front: QaWindow;
	readonly before: Observation;
}

async function notepadBehindNotepad(context: ScenarioContext, engine: Engine, tag: string): Promise<Stage> {
	await engine.activate();
	const target = await context.workspace.notepad(engine, `${tag}-target`);
	const front = await context.workspace.notepad(engine, `${tag}-front`);
	return { engine, target, front, before: await bringToFront(engine, front, [target.id]) };
}

export const foregroundTypeRestoresFront: Scenario = {
	name: "foreground-type-notepad-restores-front",
	run: (context) =>
		withEngine(context, async (engine) => {
			const { target, front, before } = await notepadBehindNotepad(context, engine, "fg");
			const text = marker("fg");
			const reply = await engine.exec("typeText", { target: target.id, text, opts: { deliveryMode: "foreground" } });
			const after = await observeUntil([target.id, front.id], (seen) => windowText(seen, target.id).includes(text));
			return verdict({
				checks: [
					["front-raised-before", String(before.foreground) === front.id],
					["type-succeeded", reply.error === undefined],
					["text-absent-before", !windowText(before, target.id).includes(text)],
					["text-landed", windowText(after, target.id).includes(text)],
					["front-restored", String(after.foreground) === front.id],
					["cursor-unchanged", after.cursor.x === before.cursor.x && after.cursor.y === before.cursor.y],
				],
				facts: { target: target.id, front: front.id, marker: text, typeError: errorCode(reply) ?? null },
				before,
				after,
			});
		}),
};

export const backgroundPostMessageNotepad: Scenario = {
	name: "background-post-message-notepad",
	run: (context) =>
		withEngine(context, async (engine) => {
			const { target, front, before } = await notepadBehindNotepad(context, engine, "bg");
			const text = marker("bg");
			const reply = await engine.exec("typeText", { target: target.id, text, opts: { deliveryMode: "background" } });
			const after = await observe([target.id, front.id]);
			const landed = windowText(after, target.id).includes(text);
			return verdict({
				checks: [
					["front-raised-before", String(before.foreground) === front.id],
					// An accepted post that never lands is the silent drop the matrix exists to prevent.
					["refused-background-unavailable", errorCode(reply) === "BackgroundUnavailable"],
					["text-unchanged", windowText(after, target.id) === windowText(before, target.id)],
					["foreground-unchanged", after.foreground === before.foreground],
				],
				facts: {
					target: target.id,
					targetClass: before.windows[target.id]?.class ?? null,
					typeError: errorCode(reply) ?? null,
					message: reply.error?.message ?? null,
					acceptedAndLanded: reply.error === undefined && landed,
					acceptedAndDropped: reply.error === undefined && !landed,
				},
				before,
				after,
			});
		}),
};

export const backgroundPostMessageWpf: Scenario = {
	name: "background-post-message-wpf",
	run: (context) =>
		withEngine(context, async (engine) => {
			await engine.activate();
			const wpf = await context.workspace.wpfWindow(engine, "bg");
			const front = await context.workspace.notepad(engine, "wpf-front");
			const before = await bringToFront(engine, front, [wpf.id]);
			const text = marker("wpf");
			const reply = await engine.exec("typeText", { target: wpf.id, text, opts: { deliveryMode: "background" } });
			const after = await observeUntil([wpf.id, front.id], (seen) => windowText(seen, wpf.id).includes(text));
			const wpfClass = before.windows[wpf.id]?.class ?? "";
			return verdict({
				checks: [
					["wpf-class", wpfClass.startsWith("HwndWrapper[")],
					["front-raised-before", String(before.foreground) === front.id],
					["type-succeeded", reply.error === undefined],
					["text-landed", windowText(after, wpf.id).includes(text)],
					["foreground-unchanged", after.foreground === before.foreground],
				],
				facts: {
					target: wpf.id,
					targetClass: wpfClass,
					front: front.id,
					typeError: errorCode(reply) ?? null,
					message: reply.error?.message ?? null,
				},
				before,
				after,
			});
		}),
};
