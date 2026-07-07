# todo14 screen model review/slop evidence

Scenario: reviewer audit for TerminalScreen exportability, catch handling, bounded replay, and test quality.
Invocation: static source review plus grep probes listed below.

## Static probes
$ rg -n "catch \{\}|as any|@ts-ignore|@ts-expect-error" packages/pty/src/screen.ts packages/pty/test/screen.test.ts packages/pty/src/index.ts packages/pty/package.json

$ rg -n "TerminalScreen|normalizeReplayHistoryLength|trimHistory|falls back|bounds resize replay|\./screen|\"test\"" packages/pty/src/screen.ts packages/pty/test/screen.test.ts packages/pty/src/index.ts packages/pty/package.json
packages/pty/package.json:14:		"./screen": {
packages/pty/package.json:32:		"test": "vitest --run test",
packages/pty/src/index.ts:33:export { TerminalScreen, type TerminalScreenOptions, type TerminalScreenSnapshot } from "./screen.ts";
packages/pty/test/screen.test.ts:4:import { TerminalScreen } from "../src/screen.ts";
packages/pty/test/screen.test.ts:8:describe("TerminalScreen", () => {
packages/pty/test/screen.test.ts:10:		const screen = new TerminalScreen({ cols: 10, rows: 3, scrollback: 10 });
packages/pty/test/screen.test.ts:20:		const screen = new TerminalScreen({ cols: 12, rows: 4, scrollback: 10 });
packages/pty/test/screen.test.ts:31:		const screen = new TerminalScreen({ cols: 6, rows: 4, scrollback: 10 });
packages/pty/test/screen.test.ts:42:		const screen = new TerminalScreen({ cols: 8, rows: 2, scrollback: 3 });
packages/pty/test/screen.test.ts:52:		const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 10 });
packages/pty/test/screen.test.ts:61:	it("falls back to a sanitized write when xterm rejects malformed text", async () => {
packages/pty/test/screen.test.ts:81:			const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 10 });
packages/pty/test/screen.test.ts:95:	it("bounds resize replay history in long sessions", async () => {
packages/pty/test/screen.test.ts:112:			const screen = new TerminalScreen({ cols: 12, rows: 2, scrollback: 2 });
packages/pty/src/screen.ts:4:export interface TerminalScreenOptions {
packages/pty/src/screen.ts:10:export interface TerminalScreenSnapshot {
packages/pty/src/screen.ts:30:export class TerminalScreen {
packages/pty/src/screen.ts:37:	constructor(options: TerminalScreenOptions = {}) {
packages/pty/src/screen.ts:41:		this.maxReplayHistoryLength = normalizeReplayHistoryLength(cols, rows, this.scrollback);
packages/pty/src/screen.ts:64:	snapshot(): TerminalScreenSnapshot {
packages/pty/src/screen.ts:123:		this.trimHistory();
packages/pty/src/screen.ts:126:	private trimHistory(): void {
packages/pty/src/screen.ts:156:function normalizeReplayHistoryLength(cols: number, rows: number, scrollback: number): number {

## Review conclusions
- Export blocker addressed: TerminalScreen is re-exported from package root and package.json exposes ./screen to dist/screen.js and dist/screen.d.ts.
- Broad catch blocker addressed: screen.ts no longer uses catch {}; write fallback catches a named error, retries only when sanitization changes the payload, and rejects otherwise.
- Fallback coverage addressed: screen.test.ts forces xterm write rejection for malformed text and asserts raw write, sanitized retry, and rendered replacement output.
- Bounded replay blocker addressed: TerminalScreen trims the resize replay history to a derived cap with hard min/max bounds; the long-session test measures the actual resize replay payload and verifies the retained recent scrollback.
- Slop review: tests are behavior-facing and non-tautological; they drive xterm writes and snapshots rather than asserting private fields, do not merely verify deletion/removal, and do not introduce production-only extraction beyond bounded replay helpers used by the implementation.
- Secret safety: artifacts contain command output and source probes only; no env dumps, tokens, cookies, auth headers, or service logs.

Binary observable: this file is non-empty and grep probes above show no broad catch/type-suppression markers in the todo14 surface.
