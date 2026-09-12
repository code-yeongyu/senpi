/**
 * The editor shortcut that expands a pending async (waitForAnswer=false)
 * question into the full AskUserQuestionComponent: a rebindable keybinding
 * action plus the macOS Option-compose glyphs that stand in for it when the
 * terminal does not report Option as Alt.
 */

import { decodeKittyPrintable, getKeybindings, type KeybindingsManager, type KeyId } from "@earendil-works/pi-tui";

/** Keybinding action (default `alt+a`, rebindable in keybindings.json) that expands the pending question. */
export const ASK_USER_ANSWER_KEYBINDING = "app.question.answer";

/**
 * What each letter key types on a US-layout macOS keyboard while Option is
 * held and the terminal lets Option compose characters instead of sending
 * Alt (the default in Terminal.app, iTerm2, Ghostty and kitty), as
 * `[Option+letter, Option+Shift+letter]`. Accepting the glyphs of the bound
 * `alt+<letter>` chords keeps the advertised shortcut working without a
 * terminal-settings detour; other platforms never see Option this way, so
 * they keep treating the glyphs as text. The dead keys `e`, `i`, `n` and `u`
 * compose with the next keystroke instead of typing a glyph, so a binding on
 * one of them needs the terminal's Option-as-Meta setting.
 */
const DARWIN_OPTION_GLYPHS: Readonly<Record<string, readonly [string, string]>> = {
	a: ["å", "Å"],
	b: ["∫", "ı"],
	c: ["ç", "Ç"],
	d: ["∂", "Î"],
	f: ["ƒ", "Ï"],
	g: ["©", "˝"],
	h: ["˙", "Ó"],
	j: ["∆", "Ô"],
	k: ["˚", "\uf8ff"],
	l: ["¬", "Ò"],
	m: ["µ", "Â"],
	o: ["ø", "Ø"],
	p: ["π", "∏"],
	q: ["œ", "Œ"],
	r: ["®", "‰"],
	s: ["ß", "Í"],
	t: ["†", "ˇ"],
	v: ["√", "◊"],
	w: ["∑", "„"],
	x: ["≈", "˛"],
	y: ["¥", "Á"],
	z: ["Ω", "¸"],
};

/** Glyphs the bound `alt+<letter>` chords type on darwin when Option composes. */
export function darwinOptionGlyphs(keys: readonly KeyId[]): ReadonlySet<string> {
	const glyphs = new Set<string>();
	for (const key of keys) {
		const letter = /^alt\+([a-z])$/i.exec(key)?.[1]?.toLowerCase();
		if (letter === undefined) continue;
		for (const glyph of DARWIN_OPTION_GLYPHS[letter] ?? []) glyphs.add(glyph);
	}
	return glyphs;
}

/** True when `data` is the editor input that expands the pending question on `platform`. */
export function matchesAskUserAnswerKey(
	data: string,
	platform: NodeJS.Platform = process.platform,
	keybindings: KeybindingsManager = getKeybindings(),
): boolean {
	if (keybindings.matches(data, ASK_USER_ANSWER_KEYBINDING)) return true;
	if (platform !== "darwin") return false;
	return darwinOptionGlyphs(keybindings.getKeys(ASK_USER_ANSWER_KEYBINDING)).has(decodeKittyPrintable(data) ?? data);
}
