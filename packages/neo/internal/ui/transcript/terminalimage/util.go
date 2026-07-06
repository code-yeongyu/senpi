package terminalimage

import (
	"context"
	"math"
	"strconv"
	"time"
)

func itoa(i int) string { return strconv.Itoa(i) }

func maxi(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clampi(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ceilDiv returns ceil(num/den) as an int, mirroring Math.ceil on a float ratio.
func ceilDiv(num, den float64) int {
	if den == 0 {
		return 0
	}
	return int(math.Ceil(num / den))
}

func contextTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}
