package transcript

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// Bounded render-signature limits, verbatim from render-signature.ts.
const (
	sigStringMaxLength        = 160
	sigStringSampleEdgeLength = 64
	sigStringSampleWindowLen  = 64
	sigArrayItemLimit         = 40
	sigObjectKeyLimit         = 80
	sigDepthLimit             = 8
)

// BoundedRenderSignature produces a stable, bounded signature string for an
// arbitrary render-input value: long strings are sampled+hashed, large arrays
// and objects are truncated with a hashed tail, nesting past the depth limit is
// collapsed, and object keys are sorted for determinism. Faithful port of
// createBoundedRenderSignature (render-signature.ts). The transcript's per-tool
// render cache keys on this, so its bounding is load-bearing for cache hits.
func BoundedRenderSignature(value any) string {
	b, _ := json.Marshal(summarizeSignatureValue(value, 0))
	return string(b)
}

func summarizeSignatureString(text string) any {
	if len(text) <= sigStringMaxLength {
		return text
	}
	sample := sampleSignatureString(text)
	return "[string length=" + strconv.Itoa(len(text)) + " hash=" + hashSignatureString(sample) + "]"
}

func sampleSignatureString(text string) string {
	n := len(text)
	first := text[:min(sigStringSampleEdgeLength, n)]
	last := text[max(0, n-sigStringSampleEdgeLength):]
	middleStart := max(0, (n-sigStringSampleWindowLen)/2)
	quarterStart := max(0, (n-sigStringSampleWindowLen)/4)
	threeQuarterStart := max(0, (n-sigStringSampleWindowLen)*3/4)
	win := func(start int) string {
		if start >= n {
			return ""
		}
		end := min(start+sigStringSampleWindowLen, n)
		return text[start:end]
	}
	return strings.Join([]string{
		first,
		win(quarterStart),
		win(middleStart),
		win(threeQuarterStart),
		last,
	}, "\x00")
}

// hashSignatureString mirrors the TS FNV-1a variant (0x811c9dc5 seed, 0x01000193
// prime, Math.imul 32-bit multiply, unsigned base-36 output).
func hashSignatureString(source string) string {
	var hash uint32 = 0x811c9dc5
	for i := 0; i < len(source); i++ {
		hash ^= uint32(source[i])
		hash = hash * 0x01000193
	}
	return strconv.FormatUint(uint64(hash), 36)
}

func hashSignatureValue(value any) string {
	b, _ := json.Marshal(summarizeSignatureValue(value, 0))
	return hashSignatureString(string(b))
}

func summarizeSignatureValue(value any, depth int) any {
	switch v := value.(type) {
	case nil:
		return nil
	case string:
		return summarizeSignatureString(v)
	case bool:
		return v
	case int:
		return v
	case int64:
		return v
	case float64:
		return v
	case json.Number:
		return v
	}

	if depth >= sigDepthLimit {
		if arr, ok := toSlice(value); ok {
			return "[array depth-limit length=" + strconv.Itoa(len(arr)) + "]"
		}
		return "[object depth-limit]"
	}

	if arr, ok := toSlice(value); ok {
		limit := min(len(arr), sigArrayItemLimit)
		out := make([]any, 0, limit+1)
		for i := 0; i < limit; i++ {
			out = append(out, summarizeSignatureValue(arr[i], depth+1))
		}
		if len(arr) > sigArrayItemLimit {
			tailHash := hashSignatureValue(arr[sigArrayItemLimit:])
			out = append(out, "[+"+strconv.Itoa(len(arr)-sigArrayItemLimit)+" items hash="+tailHash+"]")
		}
		return out
	}

	if m, ok := toMap(value); ok {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(keys))
		limit := min(len(keys), sigObjectKeyLimit)
		for i := 0; i < limit; i++ {
			k := keys[i]
			out[k] = summarizeSignatureValue(m[k], depth+1)
		}
		if len(keys) > sigObjectKeyLimit {
			omitted := make(map[string]any)
			for _, k := range keys[sigObjectKeyLimit:] {
				omitted[k] = m[k]
			}
			out["__truncatedKeys"] = "[+" + strconv.Itoa(len(keys)-sigObjectKeyLimit) + " keys hash=" + hashSignatureValue(omitted) + "]"
		}
		return out
	}

	// Unknown type: fall back to its JSON encoding as a string sample.
	b, _ := json.Marshal(value)
	return summarizeSignatureString(string(b))
}

func toSlice(value any) ([]any, bool) {
	switch v := value.(type) {
	case []any:
		return v, true
	default:
		return nil, false
	}
}

func toMap(value any) (map[string]any, bool) {
	switch v := value.(type) {
	case map[string]any:
		return v, true
	default:
		return nil, false
	}
}
