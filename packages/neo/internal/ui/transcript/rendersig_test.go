package transcript

// Ported contract for the bounded render signature. Source:
// packages/coding-agent/src/modes/interactive/components/render-signature.ts
// createBoundedRenderSignature. The transcript's per-tool render cache keys on
// this signature, so its bounding behavior (string sampling, array/key limits,
// depth cap, stable object-key ordering) is load-bearing for cache correctness.
//
// RED first: BoundedRenderSignature does not exist until the GREEN impl lands.

import (
	"strings"
	"testing"
)

func TestBoundedRenderSignature_ShortValuesInline(t *testing.T) {
	// Short strings/numbers/bools/null are embedded verbatim (JSON-encoded).
	got := BoundedRenderSignature(map[string]any{
		"a": "hi",
		"b": 3,
		"c": true,
		"d": nil,
	})
	// Keys are sorted, values inline.
	want := `{"a":"hi","b":3,"c":true,"d":null}`
	if got != want {
		t.Fatalf("sig = %s want %s", got, want)
	}
}

func TestBoundedRenderSignature_StableKeyOrdering(t *testing.T) {
	a := BoundedRenderSignature(map[string]any{"z": 1, "a": 2, "m": 3})
	b := BoundedRenderSignature(map[string]any{"a": 2, "m": 3, "z": 1})
	if a != b {
		t.Fatalf("key ordering not stable: %s vs %s", a, b)
	}
	if a != `{"a":2,"m":3,"z":1}` {
		t.Fatalf("keys not sorted: %s", a)
	}
}

func TestBoundedRenderSignature_LongStringSampled(t *testing.T) {
	// A string over SIGNATURE_STRING_MAX_LENGTH (160) collapses to a
	// [string length=N hash=H] token, so identical long strings produce the
	// same signature and different ones differ.
	long := strings.Repeat("x", 500)
	sig := BoundedRenderSignature(long)
	if !strings.Contains(sig, "[string length=500 hash=") {
		t.Fatalf("long string not sampled: %s", sig)
	}
	// Two different long strings of same length → different signatures.
	other := strings.Repeat("x", 250) + strings.Repeat("y", 250)
	if BoundedRenderSignature(other) == sig {
		t.Fatalf("distinct long strings collided")
	}
	// Identical long strings → identical signatures.
	if BoundedRenderSignature(strings.Repeat("x", 500)) != sig {
		t.Fatalf("identical long strings differ")
	}
}

func TestBoundedRenderSignature_ArrayItemLimit(t *testing.T) {
	// Arrays over SIGNATURE_ARRAY_ITEM_LIMIT (40) keep the first 40 and append a
	// single [+N items hash=H] tail token.
	arr := make([]any, 50)
	for i := range arr {
		arr[i] = i
	}
	sig := BoundedRenderSignature(arr)
	if !strings.Contains(sig, "[+10 items hash=") {
		t.Fatalf("array tail not summarized: %s", sig)
	}
}

func TestBoundedRenderSignature_DepthLimit(t *testing.T) {
	// Nesting past SIGNATURE_DEPTH_LIMIT (8) collapses to a depth-limit token.
	var v any = "leaf"
	for i := 0; i < 12; i++ {
		v = map[string]any{"n": v}
	}
	sig := BoundedRenderSignature(v)
	if !strings.Contains(sig, "depth-limit") {
		t.Fatalf("depth limit not enforced: %s", sig)
	}
}
