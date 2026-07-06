package editor

// killRing is an Emacs-style kill/yank ring, ported from
// packages/tui/src/kill-ring.ts. Consecutive kills accumulate into a single
// entry (prepend for backward deletion, append for forward deletion); yank
// pastes the most recent entry and yank-pop rotates through older entries.
type killRing struct {
	ring []string
}

// push adds text to the ring. When accumulate is true and the ring is non-empty
// the text merges with the most recent entry (prepended for backward deletion,
// appended for forward deletion). Empty text is ignored.
func (k *killRing) push(text string, prepend, accumulate bool) {
	if text == "" {
		return
	}
	if accumulate && len(k.ring) > 0 {
		last := k.ring[len(k.ring)-1]
		k.ring = k.ring[:len(k.ring)-1]
		if prepend {
			k.ring = append(k.ring, text+last)
		} else {
			k.ring = append(k.ring, last+text)
		}
		return
	}
	k.ring = append(k.ring, text)
}

// peek returns the most recent entry without modifying the ring.
func (k *killRing) peek() (string, bool) {
	if len(k.ring) == 0 {
		return "", false
	}
	return k.ring[len(k.ring)-1], true
}

// rotate moves the last entry to the front (for yank-pop cycling).
func (k *killRing) rotate() {
	if len(k.ring) > 1 {
		last := k.ring[len(k.ring)-1]
		k.ring = append([]string{last}, k.ring[:len(k.ring)-1]...)
	}
}

func (k *killRing) length() int { return len(k.ring) }
