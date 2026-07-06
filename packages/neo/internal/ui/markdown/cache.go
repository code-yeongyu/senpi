package markdown

import (
	"reflect"
	"sync"
)

// This file provides the crush-style per-message caching the task calls for: a
// bounded, content+width+theme-keyed cache shared across Markdown instances so
// streaming re-renders (which re-create Markdown for a growing string) reuse
// stable output and never re-tokenize an unchanged prefix. Bounds are fixed
// (no unbounded growth), mirroring the caps in markdown.ts.

const (
	renderCacheMax = 256
	parseCacheMax  = 128
)

// renderKey is the pure render input tuple. Two renders with equal keys produce
// byte-identical output.
type renderKey struct {
	text           string
	width          int
	contentWidth   int
	paddingX       int
	paddingY       int
	codeIndent     string
	preserveOrd    bool
	preserveEsc    bool
	themeID        uint64
	defaultStyleID uint64
	images         string
	hyperlinks     bool
}

type boundedCache[K comparable, V any] struct {
	mu    sync.Mutex
	max   int
	m     map[K]V
	order []K
}

func newBoundedCache[K comparable, V any](max int) *boundedCache[K, V] {
	return &boundedCache[K, V]{max: max, m: make(map[K]V, max)}
}

func (c *boundedCache[K, V]) get(k K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.m[k]
	return v, ok
}

func (c *boundedCache[K, V]) put(k K, v V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.m[k]; !exists {
		c.order = append(c.order, k)
		if len(c.order) > c.max {
			oldest := c.order[0]
			c.order = c.order[1:]
			delete(c.m, oldest)
		}
	}
	c.m[k] = v
}

var (
	sharedRenderCache = newBoundedCache[renderKey, []string](renderCacheMax)
	parsedCache       = newBoundedCache[parseKey, []block](parseCacheMax)
)

func getSharedRender(k renderKey) ([]string, bool) { return sharedRenderCache.get(k) }
func putSharedRender(k renderKey, v []string)      { sharedRenderCache.put(k, v) }

type parseKey struct {
	text        string
	preserveOrd bool
	preserveEsc bool
}

// getParsedTokens returns tokens for normalized source + options, memoized.
// Tokens are treated as read-only by the renderer.
func getParsedTokens(normalized string, opts Options) []block {
	k := parseKey{text: normalized, preserveOrd: opts.PreserveOrderedListMarkers, preserveEsc: opts.PreserveBackslashEscapes}
	if v, ok := parsedCache.get(k); ok {
		return v
	}
	tokens := parseDocument(normalized, opts)
	parsedCache.put(k, tokens)
	return tokens
}

// --- identity helpers for cache keys ---

var (
	themeIDMu   sync.Mutex
	themeIDs           = map[uintptr]uint64{}
	nextThemeID uint64 = 1

	styleIDMu   sync.Mutex
	styleIDs           = map[uintptr]uint64{}
	nextStyleID uint64 = 1
)

// themeID returns a stable id for a Theme value. Themes are compared by the
// identity of their Heading func pointer (themes are constructed once per skin);
// falls back to 0 for the zero theme.
func themeID(t Theme) uint64 {
	if t.Heading == nil {
		return 0
	}
	ptr := reflect.ValueOf(t.Heading).Pointer()
	themeIDMu.Lock()
	defer themeIDMu.Unlock()
	if id, ok := themeIDs[ptr]; ok {
		return id
	}
	id := nextThemeID
	nextThemeID++
	themeIDs[ptr] = id
	return id
}

func defaultStyleID(s *DefaultTextStyle) uint64 {
	if s == nil {
		return 0
	}
	ptr := reflect.ValueOf(s).Pointer()
	styleIDMu.Lock()
	defer styleIDMu.Unlock()
	if id, ok := styleIDs[ptr]; ok {
		return id
	}
	id := nextStyleID
	nextStyleID++
	styleIDs[ptr] = id
	return id
}

// ClearCaches drops all shared caches (test hook + memory-pressure escape).
func ClearCaches() {
	sharedRenderCache = newBoundedCache[renderKey, []string](renderCacheMax)
	parsedCache = newBoundedCache[parseKey, []block](parseCacheMax)
}
