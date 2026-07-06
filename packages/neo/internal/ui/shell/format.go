package shell

import "strings"

// Numeric + spacing formatters shared across the shell components. Split out of
// footer.go to keep each file under the repo's pure-LOC ceiling. Behavior
// mirrors the footer.ts number formatting (US thousands separators, toFixed).

// formatTokens renders an int with US thousands separators (footer.ts
// formatTokens uses toLocaleString("en-US")).
func formatTokens(n int) string {
	neg := n < 0
	if neg {
		n = -n
	}
	s := itoaShell(n)
	if len(s) <= 3 {
		if neg {
			return "-" + s
		}
		return s
	}
	var b strings.Builder
	first := len(s) % 3
	if first == 0 {
		first = 3
	}
	b.WriteString(s[:first])
	for i := first; i < len(s); i += 3 {
		b.WriteByte(',')
		b.WriteString(s[i : i+3])
	}
	out := b.String()
	if neg {
		return "-" + out
	}
	return out
}

// formatPct renders a float with one decimal place (toFixed(1)).
func formatPct(v float64) string {
	scaled := int(v*10 + 0.5)
	if v < 0 {
		scaled = int(v*10 - 0.5)
	}
	whole := scaled / 10
	frac := scaled % 10
	if frac < 0 {
		frac = -frac
	}
	return itoaShell(whole) + "." + itoaShell(frac)
}

// formatCost renders a cost with three decimal places (toFixed(3)).
func formatCost(v float64) string {
	scaled := int(v*1000 + 0.5)
	if v < 0 {
		scaled = int(v*1000 - 0.5)
	}
	whole := scaled / 1000
	frac := scaled % 1000
	if frac < 0 {
		frac = -frac
	}
	fracStr := itoaShell(frac)
	for len(fracStr) < 3 {
		fracStr = "0" + fracStr
	}
	return itoaShell(whole) + "." + fracStr
}

// itoaShell formats an int without importing strconv into the hot render path.
func itoaShell(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// spacesN returns n spaces (n<=0 → "").
func spacesN(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat(" ", n)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
