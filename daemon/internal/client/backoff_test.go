package client_test

import (
	"testing"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/client"
)

func TestBackoffGrowsAndCaps(t *testing.T) {
	b := client.Backoff{Base: time.Second, Max: 8 * time.Second, Factor: 2}

	want := []time.Duration{1, 2, 4, 8, 8, 8}

	for i, w := range want {
		if got := b.Next(); got != w*time.Second {
			t.Fatalf("attempt %d = %v, want %v", i, got, w*time.Second)
		}
	}

	b.Reset()

	if got := b.Next(); got != time.Second {
		t.Fatalf("after reset = %v, want 1s", got)
	}
}

func TestBackoffZeroValueDoesNotHotLoop(t *testing.T) {
	var b client.Backoff

	if got := b.Next(); got != time.Second {
		t.Fatalf("first delay = %v, want the 1s default rather than 0", got)
	}

	if got := b.Next(); got != 2*time.Second {
		t.Fatalf("second delay = %v, want 2s", got)
	}
}

func TestBackoffJitterStaysWithinTenPercent(t *testing.T) {
	for _, f := range []float64{0, 0.5, 0.999} {
		b := client.Backoff{Base: 10 * time.Second, Max: time.Minute, Factor: 2, Jitter: func() float64 { return f }}

		got := b.Next()

		if got < 9*time.Second || got > 11*time.Second {
			t.Fatalf("jitter %v gave %v, want within 10%% of 10s", f, got)
		}
	}
}
