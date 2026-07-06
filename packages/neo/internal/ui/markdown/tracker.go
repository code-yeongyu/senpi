package markdown

import (
	"strconv"
	"strings"
)

// ansiCodeTracker tracks active SGR attributes + OSC 8 hyperlink state so wrapped
// lines can re-open styling after a break. Faithful port of the AnsiCodeTracker
// class in packages/tui/src/utils.ts.
type ansiCodeTracker struct {
	bold          bool
	dim           bool
	italic        bool
	underline     bool
	blink         bool
	inverse       bool
	hidden        bool
	strikethrough bool
	fgColor       string // full code like "31" or "38;5;240"
	bgColor       string
	link          *activeHyperlink
}

type osc8Terminator string

const (
	oscBEL osc8Terminator = "\x07"
	oscST  osc8Terminator = "\x1b\\"
)

type activeHyperlink struct {
	params     string
	url        string
	terminator osc8Terminator
}

func parseOsc8Hyperlink(code string) (*activeHyperlink, bool) {
	if !strings.HasPrefix(code, "\x1b]8;") {
		return nil, false
	}
	term := oscST
	var body string
	if strings.HasSuffix(code, "\x07") {
		term = oscBEL
		body = code[4 : len(code)-1]
	} else {
		body = code[4 : len(code)-2]
	}
	sep := strings.IndexByte(body, ';')
	if sep == -1 {
		return nil, false
	}
	params := body[:sep]
	url := body[sep+1:]
	if url == "" {
		// close sequence — not an active link, but it IS an osc8 code (return nil,true)
		return nil, true
	}
	return &activeHyperlink{params: params, url: url, terminator: term}, true
}

func formatOsc8Hyperlink(h *activeHyperlink) string {
	return "\x1b]8;" + h.params + ";" + h.url + string(h.terminator)
}

func formatOsc8Close(term osc8Terminator) string {
	return "\x1b]8;;" + string(term)
}

func (t *ansiCodeTracker) process(code string) {
	if h, isOsc8 := parseOsc8Hyperlink(code); isOsc8 {
		if h != nil {
			t.link = h
		}
		// close sequence (h==nil) leaves link as-is, matching pi (only open sets it)
		return
	}
	if !strings.HasSuffix(code, "m") {
		return
	}
	// extract params between ESC[ and m
	if !strings.HasPrefix(code, "\x1b[") {
		return
	}
	params := code[2 : len(code)-1]
	if params == "" || params == "0" {
		t.reset()
		return
	}
	parts := strings.Split(params, ";")
	i := 0
	for i < len(parts) {
		code, err := strconv.Atoi(parts[i])
		if err != nil {
			i++
			continue
		}
		if code == 38 || code == 48 {
			if i+2 < len(parts) && parts[i+1] == "5" {
				colorCode := parts[i] + ";" + parts[i+1] + ";" + parts[i+2]
				if code == 38 {
					t.fgColor = colorCode
				} else {
					t.bgColor = colorCode
				}
				i += 3
				continue
			}
			if i+4 < len(parts) && parts[i+1] == "2" {
				colorCode := parts[i] + ";" + parts[i+1] + ";" + parts[i+2] + ";" + parts[i+3] + ";" + parts[i+4]
				if code == 38 {
					t.fgColor = colorCode
				} else {
					t.bgColor = colorCode
				}
				i += 5
				continue
			}
		}
		switch code {
		case 0:
			t.reset()
		case 1:
			t.bold = true
		case 2:
			t.dim = true
		case 3:
			t.italic = true
		case 4:
			t.underline = true
		case 5:
			t.blink = true
		case 7:
			t.inverse = true
		case 8:
			t.hidden = true
		case 9:
			t.strikethrough = true
		case 21:
			t.bold = false
		case 22:
			t.bold = false
			t.dim = false
		case 23:
			t.italic = false
		case 24:
			t.underline = false
		case 25:
			t.blink = false
		case 27:
			t.inverse = false
		case 28:
			t.hidden = false
		case 29:
			t.strikethrough = false
		case 39:
			t.fgColor = ""
		case 49:
			t.bgColor = ""
		default:
			if (code >= 30 && code <= 37) || (code >= 90 && code <= 97) {
				t.fgColor = strconv.Itoa(code)
			} else if (code >= 40 && code <= 47) || (code >= 100 && code <= 107) {
				t.bgColor = strconv.Itoa(code)
			}
		}
		i++
	}
}

func (t *ansiCodeTracker) reset() {
	t.bold = false
	t.dim = false
	t.italic = false
	t.underline = false
	t.blink = false
	t.inverse = false
	t.hidden = false
	t.strikethrough = false
	t.fgColor = ""
	t.bgColor = ""
	// SGR reset does not clear OSC 8 hyperlink state (matches pi).
}

func (t *ansiCodeTracker) getActiveCodes() string {
	var codes []string
	if t.bold {
		codes = append(codes, "1")
	}
	if t.dim {
		codes = append(codes, "2")
	}
	if t.italic {
		codes = append(codes, "3")
	}
	if t.underline {
		codes = append(codes, "4")
	}
	if t.blink {
		codes = append(codes, "5")
	}
	if t.inverse {
		codes = append(codes, "7")
	}
	if t.hidden {
		codes = append(codes, "8")
	}
	if t.strikethrough {
		codes = append(codes, "9")
	}
	if t.fgColor != "" {
		codes = append(codes, t.fgColor)
	}
	if t.bgColor != "" {
		codes = append(codes, t.bgColor)
	}
	var result string
	if len(codes) > 0 {
		result = "\x1b[" + strings.Join(codes, ";") + "m"
	}
	if t.link != nil {
		result += formatOsc8Hyperlink(t.link)
	}
	return result
}

func (t *ansiCodeTracker) hasActiveCodes() bool {
	return t.bold || t.dim || t.italic || t.underline || t.blink || t.inverse ||
		t.hidden || t.strikethrough || t.fgColor != "" || t.bgColor != "" || t.link != nil
}

// getLineEndReset closes underline + OSC 8 at a line break; both re-open at the
// next line start via getActiveCodes. Port of AnsiCodeTracker.getLineEndReset.
func (t *ansiCodeTracker) getLineEndReset() string {
	var result string
	if t.underline {
		result += "\x1b[24m"
	}
	if t.link != nil {
		result += formatOsc8Close(t.link.terminator)
	}
	return result
}

func updateTrackerFromText(text string, t *ansiCodeTracker) {
	i := 0
	for i < len(text) {
		if code, n, ok := extractAnsiCode(text, i); ok {
			t.process(code)
			i += n
		} else {
			i++
		}
	}
}
