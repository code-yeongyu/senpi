package keybindings

import "testing"

// keys_test.go is the Go port of packages/tui/test/keys.test.ts (the named
// contract for plan task 6). Each subtest name mirrors a `describe > it` case in
// the TS file; the mapping table lives in the task-6 evidence file. The classic
// engine (keys.ts) is the ground truth for raw-sequence matching, so these tests
// encode the EXACT byte strings and expected results from that suite.
//
// Written RED first: the stub MatchesKey/ParseKey/Decode* return zero values, so
// every assertion below fails until the port lands.

// withKitty runs fn with the process-global Kitty flag set, restoring it after.
func withKitty(active bool, fn func()) {
	prev := IsKittyProtocolActive()
	SetKittyProtocolActive(active)
	defer SetKittyProtocolActive(prev)
	fn()
}

func assertMatch(t *testing.T, data, keyID string, want bool) {
	t.Helper()
	if got := MatchesKey(data, keyID); got != want {
		t.Errorf("MatchesKey(%q, %q) = %v, want %v", data, keyID, got, want)
	}
}

func assertParse(t *testing.T, data, want string) {
	t.Helper()
	got, ok := ParseKey(data)
	if want == "" {
		if ok {
			t.Errorf("ParseKey(%q) = %q, want undefined", data, got)
		}
		return
	}
	if !ok || got != want {
		t.Errorf("ParseKey(%q) = (%q, %v), want %q", data, got, ok, want)
	}
}

// ---------------------------------------------------------------------------
// matchesKey > Kitty protocol with alternate keys (non-Latin layouts)
// ---------------------------------------------------------------------------

func TestMatchesKey_Kitty_CyrillicCtrlC_baseLayout(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[1089::99;5u", "ctrl+c", true) })
}

func TestMatchesKey_Kitty_CyrillicCtrlD_baseLayout(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[1074::100;5u", "ctrl+d", true) })
}

func TestMatchesKey_Kitty_CyrillicCtrlZ_baseLayout(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[1103::122;5u", "ctrl+z", true) })
}

func TestMatchesKey_Kitty_CtrlShiftP_baseLayout(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[1079::112;6u", "ctrl+shift+p", true) })
}

func TestMatchesKey_Kitty_directCodepoint_noBaseLayout(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[99;5u", "ctrl+c", true) })
}

func TestMatchesKey_Kitty_superModifiers(t *testing.T) {
	withKitty(true, func() {
		assertMatch(t, "\x1b[107;9u", "super+k", true)
		assertMatch(t, "\x1b[13;9u", "super+enter", true)
		assertMatch(t, "\x1b[107;13u", "ctrl+super+k", true)
		assertMatch(t, "\x1b[107;14u", "ctrl+shift+super+k", true)
		assertMatch(t, "\x1b[107;13u", "super+k", false)
		assertParse(t, "\x1b[107;9u", "super+k")
		assertParse(t, "\x1b[13;9u", "super+enter")
		assertParse(t, "\x1b[107;13u", "ctrl+super+k")
		assertParse(t, "\x1b[107;14u", "shift+ctrl+super+k")
	})
}

func TestMatchesKey_Kitty_digitBindings(t *testing.T) {
	withKitty(true, func() {
		assertMatch(t, "\x1b[49u", "1", true)
		assertMatch(t, "\x1b[49;5u", "ctrl+1", true)
		assertMatch(t, "\x1b[49;5u", "ctrl+2", false)
		assertParse(t, "\x1b[49u", "1")
		assertParse(t, "\x1b[49;5u", "ctrl+1")
	})
}

func TestMatchesKey_Kitty_modifiedEnter(t *testing.T) {
	shiftEnter := "\x1b[13;2u"
	ctrlEnter := "\x1b[13;5u"
	altEnter := "\x1b[13;3u"
	withKitty(false, func() {
		assertMatch(t, shiftEnter, "shift+enter", true)
		assertMatch(t, ctrlEnter, "ctrl+enter", true)
		assertMatch(t, altEnter, "alt+enter", true)
		assertMatch(t, shiftEnter, "enter", false)
		assertParse(t, shiftEnter, "shift+enter")
		assertParse(t, ctrlEnter, "ctrl+enter")
		assertParse(t, altEnter, "alt+enter")
	})
}

func TestMatchesKey_Kitty_keypadNormalization(t *testing.T) {
	withKitty(true, func() {
		assertMatch(t, "\x1b[57400u", "1", true)
		assertMatch(t, "\x1b[57410u", "/", true)
		assertMatch(t, "\x1b[57417u", "left", true)
		assertMatch(t, "\x1b[57426u", "delete", true)
		assertParse(t, "\x1b[57399u", "0")
		assertParse(t, "\x1b[57409u", ".")
		assertParse(t, "\x1b[57413u", "+")
		assertParse(t, "\x1b[57416u", ",")
		assertParse(t, "\x1b[57417u", "left")
		assertParse(t, "\x1b[57418u", "right")
		assertParse(t, "\x1b[57419u", "up")
		assertParse(t, "\x1b[57420u", "down")
		assertParse(t, "\x1b[57421u", "pageUp")
		assertParse(t, "\x1b[57422u", "pageDown")
		assertParse(t, "\x1b[57423u", "home")
		assertParse(t, "\x1b[57424u", "end")
		assertParse(t, "\x1b[57425u", "insert")
		assertParse(t, "\x1b[57426u", "delete")
	})
}

func TestMatchesKey_Kitty_shiftedKeyInFormat(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[99:67:99;2u", "shift+c", true) })
}

func TestMatchesKey_Kitty_eventTypeInFormat(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[1089::99;5:3u", "ctrl+c", true) })
}

func TestMatchesKey_Kitty_fullFormat(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[1089:1057:99;6:2u", "ctrl+shift+c", true) })
}

func TestMatchesKey_Kitty_preferCodepointForLatinLetters(t *testing.T) {
	withKitty(true, func() {
		assertMatch(t, "\x1b[107::118;5u", "ctrl+k", true)
		assertMatch(t, "\x1b[107::118;5u", "ctrl+v", false)
	})
}

func TestMatchesKey_Kitty_preferCodepointForSymbols(t *testing.T) {
	withKitty(true, func() {
		assertMatch(t, "\x1b[47::91;5u", "ctrl+/", true)
		assertMatch(t, "\x1b[47::91;5u", "ctrl+[", false)
	})
}

func TestMatchesKey_Kitty_notMatchWrongKey(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[1089::99;5u", "ctrl+d", false) })
}

func TestMatchesKey_Kitty_notMatchWrongModifiers(t *testing.T) {
	withKitty(true, func() { assertMatch(t, "\x1b[1089::99;5u", "ctrl+shift+c", false) })
}

// ---------------------------------------------------------------------------
// matchesKey > modifyOtherKeys matching
// ---------------------------------------------------------------------------

func TestMatchesKey_MOK_CtrlC(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;5;99~", "ctrl+c", true)
		assertParse(t, "\x1b[27;5;99~", "ctrl+c")
	})
}

func TestMatchesKey_MOK_CtrlD(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;5;100~", "ctrl+d", true)
		assertParse(t, "\x1b[27;5;100~", "ctrl+d")
	})
}

func TestMatchesKey_MOK_CtrlZ(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;5;122~", "ctrl+z", true)
		assertParse(t, "\x1b[27;5;122~", "ctrl+z")
	})
}

func TestMatchesKey_MOK_EnterVariants(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;5;13~", "ctrl+enter", true)
		assertMatch(t, "\x1b[27;2;13~", "shift+enter", true)
		assertMatch(t, "\x1b[27;3;13~", "alt+enter", true)
		assertParse(t, "\x1b[27;5;13~", "ctrl+enter")
		assertParse(t, "\x1b[27;2;13~", "shift+enter")
		assertParse(t, "\x1b[27;3;13~", "alt+enter")
	})
}

func TestMatchesKey_MOK_TabVariants(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;2;9~", "shift+tab", true)
		assertMatch(t, "\x1b[27;5;9~", "ctrl+tab", true)
		assertMatch(t, "\x1b[27;3;9~", "alt+tab", true)
		assertParse(t, "\x1b[27;2;9~", "shift+tab")
		assertParse(t, "\x1b[27;5;9~", "ctrl+tab")
		assertParse(t, "\x1b[27;3;9~", "alt+tab")
	})
}

func TestMatchesKey_MOK_BackspaceVariants(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;1;127~", "backspace", true)
		assertMatch(t, "\x1b[27;5;127~", "ctrl+backspace", true)
		assertMatch(t, "\x1b[27;3;127~", "alt+backspace", true)
		assertParse(t, "\x1b[27;1;127~", "backspace")
		assertParse(t, "\x1b[27;5;127~", "ctrl+backspace")
		assertParse(t, "\x1b[27;3;127~", "alt+backspace")
	})
}

func TestMatchesKey_MOK_Escape(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;1;27~", "escape", true)
		assertParse(t, "\x1b[27;1;27~", "escape")
	})
}

func TestMatchesKey_MOK_SpaceVariants(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;1;32~", "space", true)
		assertMatch(t, "\x1b[27;5;32~", "ctrl+space", true)
		assertParse(t, "\x1b[27;1;32~", "space")
		assertParse(t, "\x1b[27;5;32~", "ctrl+space")
	})
}

func TestMatchesKey_MOK_SymbolCombos(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;5;47~", "ctrl+/", true)
		assertParse(t, "\x1b[27;5;47~", "ctrl+/")
	})
}

func TestMatchesKey_MOK_DigitCombos(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;5;49~", "ctrl+1", true)
		assertMatch(t, "\x1b[27;2;49~", "shift+1", true)
		assertParse(t, "\x1b[27;5;49~", "ctrl+1")
		assertParse(t, "\x1b[27;2;49~", "shift+1")
	})
}

func TestMatchesKey_MOK_ShiftedUppercaseLetters(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;2;69~", "shift+e", true)
		assertMatch(t, "\x1b[27;6;69~", "ctrl+shift+e", true)
		assertParse(t, "\x1b[27;2;69~", "shift+e")
		assertParse(t, "\x1b[27;6;69~", "shift+ctrl+e")
	})
}

func TestMatchesKey_CtrlAltLetter_CSIu(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[104;7u", "ctrl+alt+h", true)
		assertParse(t, "\x1b[104;7u", "ctrl+alt+h")
	})
}

func TestMatchesKey_CtrlAltLetter_MOK(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b[27;7;104~", "ctrl+alt+h", true)
		assertParse(t, "\x1b[27;7;104~", "ctrl+alt+h")
	})
}

// ---------------------------------------------------------------------------
// matchesKey > Legacy key matching
// ---------------------------------------------------------------------------

func TestMatchesKey_Legacy_CtrlC(t *testing.T) {
	withKitty(false, func() { assertMatch(t, "\x03", "ctrl+c", true) })
}

func TestMatchesKey_Legacy_CtrlD(t *testing.T) {
	withKitty(false, func() { assertMatch(t, "\x04", "ctrl+d", true) })
}

func TestMatchesKey_Legacy_Escape(t *testing.T) {
	assertMatch(t, "\x1b", "escape", true)
}

func TestMatchesKey_Legacy_LinefeedAsEnter(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\n", "enter", true)
		assertParse(t, "\n", "enter")
	})
}

func TestMatchesKey_Legacy_LinefeedAsShiftEnterKitty(t *testing.T) {
	withKitty(true, func() {
		assertMatch(t, "\n", "shift+enter", true)
		assertMatch(t, "\n", "enter", false)
		assertParse(t, "\n", "shift+enter")
	})
}

func TestMatchesKey_Legacy_CtrlSpace(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x00", "ctrl+space", true)
		assertParse(t, "\x00", "ctrl+space")
	})
}

func TestMatchesKey_Legacy_CtrlSymbol(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1c", "ctrl+\\", true)
		assertParse(t, "\x1c", "ctrl+\\")
		assertMatch(t, "\x1d", "ctrl+]", true)
		assertParse(t, "\x1d", "ctrl+]")
		assertMatch(t, "\x1f", "ctrl+_", true)
		assertMatch(t, "\x1f", "ctrl+-", true)
		assertParse(t, "\x1f", "ctrl+-")
	})
}

func TestMatchesKey_Legacy_CtrlAltSymbol(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b\x1b", "ctrl+alt+[", true)
		assertParse(t, "\x1b\x1b", "ctrl+alt+[")
		assertMatch(t, "\x1b\x1c", "ctrl+alt+\\", true)
		assertParse(t, "\x1b\x1c", "ctrl+alt+\\")
		assertMatch(t, "\x1b\x1d", "ctrl+alt+]", true)
		assertParse(t, "\x1b\x1d", "ctrl+alt+]")
		assertMatch(t, "\x1b\x1f", "ctrl+alt+_", true)
		assertMatch(t, "\x1b\x1f", "ctrl+alt+-", true)
		assertParse(t, "\x1b\x1f", "ctrl+alt+-")
	})
}

func TestMatchesKey_Legacy_RawBackspaceNonWT(t *testing.T) {
	withKitty(false, func() {
		withEnvT(t, "WT_SESSION", "", func() {
			assertMatch(t, "\x7f", "backspace", true)
			assertMatch(t, "\x7f", "ctrl+backspace", false)
			assertParse(t, "\x7f", "backspace")
			assertMatch(t, "\x08", "backspace", true)
			assertMatch(t, "\x08", "ctrl+backspace", false)
			assertParse(t, "\x08", "backspace")
			assertMatch(t, "\x08", "ctrl+h", true)
		})
	})
}

func TestMatchesKey_Legacy_RawBackspaceLocalWT(t *testing.T) {
	withKitty(false, func() {
		withEnvVarsT(t, map[string]string{
			"WT_SESSION":     "test-session",
			"SSH_CONNECTION": "",
			"SSH_CLIENT":     "",
			"SSH_TTY":        "",
		}, func() {
			assertMatch(t, "\x08", "ctrl+backspace", true)
			assertMatch(t, "\x08", "backspace", false)
			assertParse(t, "\x08", "ctrl+backspace")
			assertMatch(t, "\x08", "ctrl+h", true)
		})
	})
}

func TestMatchesKey_Legacy_RawBackspaceWTOverSSH(t *testing.T) {
	withKitty(false, func() {
		withEnvVarsT(t, map[string]string{
			"WT_SESSION":     "test-session",
			"SSH_CONNECTION": "1 2 3 4",
			"SSH_CLIENT":     "1 2 3",
			"SSH_TTY":        "/dev/pts/1",
		}, func() {
			assertMatch(t, "\x08", "ctrl+backspace", false)
			assertMatch(t, "\x08", "backspace", true)
			assertParse(t, "\x08", "backspace")
			assertMatch(t, "\x08", "ctrl+h", true)
		})
	})
}

func TestMatchesKey_Legacy_AltPrefixedSequences(t *testing.T) {
	withKitty(false, func() {
		assertMatch(t, "\x1b ", "alt+space", true)
		assertParse(t, "\x1b ", "alt+space")
		assertMatch(t, "\x1b\b", "alt+backspace", true)
		assertParse(t, "\x1b\b", "alt+backspace")
		assertMatch(t, "\x1b\x03", "ctrl+alt+c", true)
		assertParse(t, "\x1b\x03", "ctrl+alt+c")
		assertMatch(t, "\x1bB", "alt+left", true)
		assertParse(t, "\x1bB", "alt+left")
		assertMatch(t, "\x1bF", "alt+right", true)
		assertParse(t, "\x1bF", "alt+right")
		assertMatch(t, "\x1ba", "alt+a", true)
		assertParse(t, "\x1ba", "alt+a")
		assertMatch(t, "\x1b1", "alt+1", true)
		assertParse(t, "\x1b1", "alt+1")
		assertMatch(t, "\x1by", "alt+y", true)
		assertParse(t, "\x1by", "alt+y")
		assertMatch(t, "\x1bz", "alt+z", true)
		assertParse(t, "\x1bz", "alt+z")
	})
	withKitty(true, func() {
		assertMatch(t, "\x1b ", "alt+space", false)
		assertParse(t, "\x1b ", "")
		assertMatch(t, "\x1b\b", "alt+backspace", true)
		assertParse(t, "\x1b\b", "alt+backspace")
		assertMatch(t, "\x1b\x03", "ctrl+alt+c", false)
		assertParse(t, "\x1b\x03", "")
		assertMatch(t, "\x1bB", "alt+left", false)
		assertParse(t, "\x1bB", "")
		assertMatch(t, "\x1bF", "alt+right", false)
		assertParse(t, "\x1bF", "")
		assertMatch(t, "\x1ba", "alt+a", false)
		assertParse(t, "\x1ba", "")
		assertMatch(t, "\x1b1", "alt+1", false)
		assertParse(t, "\x1b1", "")
		assertMatch(t, "\x1by", "alt+y", false)
		assertParse(t, "\x1by", "")
	})
}

func TestMatchesKey_Legacy_ArrowKeys(t *testing.T) {
	assertMatch(t, "\x1b[A", "up", true)
	assertMatch(t, "\x1b[B", "down", true)
	assertMatch(t, "\x1b[C", "right", true)
	assertMatch(t, "\x1b[D", "left", true)
}

func TestMatchesKey_Legacy_SS3ArrowsHomeEnd(t *testing.T) {
	assertMatch(t, "\x1bOA", "up", true)
	assertMatch(t, "\x1bOB", "down", true)
	assertMatch(t, "\x1bOC", "right", true)
	assertMatch(t, "\x1bOD", "left", true)
	assertMatch(t, "\x1bOH", "home", true)
	assertMatch(t, "\x1bOF", "end", true)
}

func TestMatchesKey_Legacy_FunctionKeysAndClear(t *testing.T) {
	assertMatch(t, "\x1bOP", "f1", true)
	assertMatch(t, "\x1b[24~", "f12", true)
	assertMatch(t, "\x1b[E", "clear", true)
}

func TestMatchesKey_Legacy_AltArrows(t *testing.T) {
	assertMatch(t, "\x1bp", "alt+up", true)
	assertMatch(t, "\x1bp", "up", false)
}

func TestMatchesKey_Legacy_RxvtModifierSequences(t *testing.T) {
	assertMatch(t, "\x1b[a", "shift+up", true)
	assertMatch(t, "\x1bOa", "ctrl+up", true)
	assertMatch(t, "\x1b[2$", "shift+insert", true)
	assertMatch(t, "\x1b[2^", "ctrl+insert", true)
	assertMatch(t, "\x1b[7$", "shift+home", true)
}

// ---------------------------------------------------------------------------
// decodeKittyPrintable
// ---------------------------------------------------------------------------

func TestDecodeKittyPrintable_KeypadFunctionalKeys(t *testing.T) {
	cases := []struct {
		data, want string
		ok         bool
	}{
		{"\x1b[57399u", "0", true},
		{"\x1b[57400u", "1", true},
		{"\x1b[57409u", ".", true},
		{"\x1b[57410u", "/", true},
		{"\x1b[57411u", "*", true},
		{"\x1b[57412u", "-", true},
		{"\x1b[57413u", "+", true},
		{"\x1b[57415u", "=", true},
		{"\x1b[57416u", ",", true},
		{"\x1b[57417u", "", false},
	}
	for _, c := range cases {
		got, ok := DecodeKittyPrintable(c.data)
		if ok != c.ok || (c.ok && got != c.want) {
			t.Errorf("DecodeKittyPrintable(%q) = (%q,%v), want (%q,%v)", c.data, got, ok, c.want, c.ok)
		}
	}
}

// ---------------------------------------------------------------------------
// decodePrintableKey
// ---------------------------------------------------------------------------

func TestDecodePrintableKey_ModifyOtherKeys(t *testing.T) {
	cases := []struct {
		data, want string
		ok         bool
	}{
		{"\x1b[27;2;69~", "E", true},
		{"\x1b[27;2;196~", "Ä", true},
		{"\x1b[27;2;32~", " ", true},
		{"\x1b[27;2;13~", "", false},
		{"\x1b[27;6;69~", "", false},
	}
	for _, c := range cases {
		got, ok := DecodePrintableKey(c.data)
		if ok != c.ok || (c.ok && got != c.want) {
			t.Errorf("DecodePrintableKey(%q) = (%q,%v), want (%q,%v)", c.data, got, ok, c.want, c.ok)
		}
	}
}

// ---------------------------------------------------------------------------
// parseKey > Kitty protocol with alternate keys
// ---------------------------------------------------------------------------

func TestParseKey_Kitty_LatinNameWhenBaseLayoutPresent(t *testing.T) {
	withKitty(true, func() { assertParse(t, "\x1b[1089::99;5u", "ctrl+c") })
}

func TestParseKey_Kitty_PreferCodepointLatinLetters(t *testing.T) {
	withKitty(true, func() { assertParse(t, "\x1b[107::118;5u", "ctrl+k") })
}

func TestParseKey_Kitty_PreferCodepointSymbols(t *testing.T) {
	withKitty(true, func() { assertParse(t, "\x1b[47::91;5u", "ctrl+/") })
}

func TestParseKey_Kitty_NameFromCodepointNoBaseLayout(t *testing.T) {
	withKitty(true, func() { assertParse(t, "\x1b[99;5u", "ctrl+c") })
}

func TestParseKey_Kitty_ShiftedUppercaseLetters(t *testing.T) {
	withKitty(true, func() {
		assertMatch(t, "\x1b[69;2u", "shift+e", true)
		assertParse(t, "\x1b[69;2u", "shift+e")
	})
}

func TestParseKey_Kitty_IgnoreUnsupportedModifiers(t *testing.T) {
	withKitty(true, func() { assertParse(t, "\x1b[99;17u", "") })
}

// ---------------------------------------------------------------------------
// parseKey > Legacy key parsing
// ---------------------------------------------------------------------------

func TestParseKey_Legacy_CtrlLetter(t *testing.T) {
	withKitty(false, func() {
		assertParse(t, "\x03", "ctrl+c")
		assertParse(t, "\x04", "ctrl+d")
	})
}

func TestParseKey_Legacy_SpecialKeys(t *testing.T) {
	assertParse(t, "\x1b", "escape")
	assertParse(t, "\t", "tab")
	assertParse(t, "\r", "enter")
	assertParse(t, "\n", "enter")
	assertParse(t, "\x00", "ctrl+space")
	assertParse(t, " ", "space")
	assertParse(t, "1", "1")
	assertMatch(t, "1", "1", true)
}

func TestParseKey_Legacy_ArrowKeys(t *testing.T) {
	assertParse(t, "\x1b[A", "up")
	assertParse(t, "\x1b[B", "down")
	assertParse(t, "\x1b[C", "right")
	assertParse(t, "\x1b[D", "left")
}

func TestParseKey_Legacy_SS3ArrowsHomeEnd(t *testing.T) {
	assertParse(t, "\x1bOA", "up")
	assertParse(t, "\x1bOB", "down")
	assertParse(t, "\x1bOC", "right")
	assertParse(t, "\x1bOD", "left")
	assertParse(t, "\x1bOH", "home")
	assertParse(t, "\x1bOF", "end")
}

func TestParseKey_Legacy_FunctionAndModifierSequences(t *testing.T) {
	assertParse(t, "\x1bOP", "f1")
	assertParse(t, "\x1b[24~", "f12")
	assertParse(t, "\x1b[E", "clear")
	assertParse(t, "\x1b[2^", "ctrl+insert")
	assertParse(t, "\x1bp", "alt+up")
}

func TestParseKey_Legacy_DoubleBracketPageUp(t *testing.T) {
	assertParse(t, "\x1b[[5~", "pageUp")
}
