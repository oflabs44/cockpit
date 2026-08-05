package client

import "time"

// Backoff produces the reconnect delay sequence: exponential, capped, with
// optional jitter (type-design section 3.3).
type Backoff struct {
	Base   time.Duration
	Max    time.Duration
	Factor float64
	// Jitter returns a fraction in [0,1) applied as +/- 10% of the delay. Nil
	// means no jitter, which is what tests use.
	Jitter func() float64

	attempt int
}

// Next returns the delay for the next attempt and advances the sequence.
// Unset fields fall back to defaults rather than yielding a zero delay, which
// would be a hot reconnect loop.
func (b *Backoff) Next() time.Duration {
	if b.Base <= 0 {
		b.Base = time.Second
	}

	if b.Max < b.Base {
		b.Max = 2 * time.Minute
	}

	if b.Factor <= 1 {
		b.Factor = 2
	}

	d := float64(b.Base)

	for i := 0; i < b.attempt; i++ {
		d *= b.Factor

		if d >= float64(b.Max) {
			d = float64(b.Max)

			break
		}
	}

	b.attempt++

	if b.Jitter != nil {
		d *= 0.9 + 0.2*b.Jitter()
	}

	return time.Duration(d)
}

// Reset returns the sequence to its start. Called after a connection has
// carried a successful handshake, so a long-lived session that later drops
// reconnects promptly.
func (b *Backoff) Reset() {
	b.attempt = 0
}
