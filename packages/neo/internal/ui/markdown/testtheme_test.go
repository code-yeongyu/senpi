package markdown

import "strings"

// defaultMarkdownTheme is the Go equivalent of packages/tui/test/test-themes.ts
// `defaultMarkdownTheme`, emitting the exact chalk level-3 ANSI codes the ported
// contract asserts against. Each style opens with its SGR and closes with the
// matching reset, exactly like chalk so nested styles interleave identically.
//
//	heading         -> bold + cyan   (\x1b[1m \x1b[36m)
//	link            -> blue          (\x1b[34m)
//	linkUrl         -> dim           (\x1b[2m)
//	code            -> yellow        (\x1b[33m)
//	codeBlock       -> green         (\x1b[32m)
//	codeBlockBorder -> dim           (\x1b[2m)
//	quote           -> italic        (\x1b[3m)
//	quoteBorder     -> dim           (\x1b[2m)
//	hr              -> dim           (\x1b[2m)
//	listBullet      -> cyan          (\x1b[36m)
//	bold            -> bold          (\x1b[1m)
//	italic          -> italic        (\x1b[3m)
//	strikethrough   -> strikethrough (\x1b[9m)
//	underline       -> underline     (\x1b[4m)
func sgr(open, close int) StyleFunc {
	o := "\x1b[" + itoa(open) + "m"
	c := "\x1b[" + itoa(close) + "m"
	return func(text string) string { return o + text + c }
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [4]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// chalk.bold.cyan composes bold(cyan(x)) in chalk, producing
// \x1b[1m\x1b[36m X \x1b[39m\x1b[22m. We replicate by nesting.
func headingStyle(text string) string {
	cyan := sgr(36, 39)
	bold := sgr(1, 22)
	return bold(cyan(text))
}

func defaultMarkdownTheme() Theme {
	return Theme{
		Heading:         headingStyle,
		Link:            sgr(34, 39),
		LinkURL:         sgr(2, 22),
		Code:            sgr(33, 39),
		CodeBlock:       sgr(32, 39),
		CodeBlockBorder: sgr(2, 22),
		Quote:           sgr(3, 23),
		QuoteBorder:     sgr(2, 22),
		HR:              sgr(2, 22),
		ListBullet:      sgr(36, 39),
		Bold:            sgr(1, 22),
		Italic:          sgr(3, 23),
		Strikethrough:   sgr(9, 29),
		Underline:       sgr(4, 24),
	}
}

// stripANSI removes CSI SGR sequences (\x1b[...m), mirroring the test helper
// `line.replace(/\x1b\[[0-9;]*m/g, "")`.
func stripANSI(line string) string {
	var b strings.Builder
	i := 0
	for i < len(line) {
		if line[i] == 0x1b && i+1 < len(line) && line[i+1] == '[' {
			j := i + 2
			for j < len(line) && line[j] != 'm' {
				// only digits and ';' belong to an SGR; bail out otherwise
				if line[j] != ';' && (line[j] < '0' || line[j] > '9') {
					break
				}
				j++
			}
			if j < len(line) && line[j] == 'm' {
				i = j + 1
				continue
			}
		}
		b.WriteByte(line[i])
		i++
	}
	return b.String()
}

func trimEnd(s string) string { return strings.TrimRight(s, " \t") }

func mapLines(lines []string, f func(string) string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = f(l)
	}
	return out
}

func plain(lines []string) []string {
	return mapLines(lines, func(l string) string { return trimEnd(stripANSI(l)) })
}

func joinLines(lines []string, sep string) string { return strings.Join(lines, sep) }
