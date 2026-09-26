import { AgentSession, type Json, type ToolOutcome } from "./agent.ts";
import { type KeySink, settle } from "./fixtures.ts";
import { postKeystroke } from "./observer.ts";

export const SCENARIOS = [
	"preflight",
	"background-click-keeps-focus",
	"background-type-sole-window",
	"background-type-multiwindow-refused",
	"foreground-restores",
	"killswitch-real-hid",
	"tcc-diagnostic",
	"screenshot-budget",
	"capabilities-truth",
	"canary",
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

export function isScenarioName(value: string): value is ScenarioName {
	return SCENARIOS.some((name) => name === value);
}

/** One JSON line of the run. */
export interface ScenarioResult {
	readonly scenario: ScenarioName;
	readonly pass: boolean;
	readonly facts: Json;
}

export interface RunOptions {
	/** QA-only: request `delivery:"foreground"` while still asserting the background contract. */
	readonly forceForeground: boolean;
	/** The control-mengmotahost JetKVM CLI that presses the real-HID stop chord. */
	readonly jetkvm: string | undefined;
	/** Where JetKVM screenshot pairs go (supplementary evidence only, never a truth source). */
	readonly kvmShots: string | undefined;
}

/** A fresh coding-agent session with computer use switched on, closed afterwards whatever happens. */
export async function withSession<T>(computer: Json, use: (session: AgentSession) => Promise<T>): Promise<T> {
	const session = new AgentSession(computer);
	try {
		await session.command("on");
		return await use(session);
	} finally {
		await session.close();
	}
}

/**
 * `run` code for one TextEdit window: resolve it by title, capture it (the coordinate frame input needs), then
 * `body`, which sees `w` and `s` (the capture) and returns the value.
 */
export function onWindow(title: string, body: string): Json {
	const code = [
		`const w = await desktop.window({ app: "TextEdit", title: ${JSON.stringify(title)} });`,
		"const s = await w.screenshot({ silent: true });",
		body,
	].join("\n");
	return { action: "run", code, timeout: 300 };
}

/** Background move into the window's centre: the first background action, so the session canary fires here. */
export function warmUp(session: AgentSession, title: string): Promise<ToolOutcome> {
	return session.call(
		onWindow(title, `await w.move(Math.round(s.width / 2), Math.round(s.height / 2)); return "warm";`),
	);
}

/** A click into the lower text area, where the caret lands at the end of the text. */
export function clickCode(title: string, delivery: string): Json {
	const click = `await w.click(Math.round(s.width / 2), Math.round(s.height * 0.8), { delivery: ${JSON.stringify(delivery)} });`;
	return onWindow(title, `${click}\nreturn "clicked";`);
}

/** `null` when the call succeeded; its error text otherwise. */
export function toolError(outcome: ToolOutcome): string | null {
	return outcome.isError ? outcome.text : null;
}

/** Posts a fresh digit token through the observer and reports whether the sink's tty received it. */
export async function keyLands(sink: KeySink): Promise<{ readonly token: string; readonly landed: boolean }> {
	const token = String(Date.now()).slice(-6);
	await postKeystroke(token);
	const landed = await settle(
		"keystroke in the key sink",
		async () => sink.read(),
		(text) => text.includes(token),
	)
		.then(() => true)
		.catch(() => false);
	return { token, landed };
}
