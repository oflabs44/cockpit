package claim_test

import (
	"strings"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/claim"
)

func TestNewShape(t *testing.T) {
	seen := map[string]bool{}

	for i := 0; i < 200; i++ {
		c, err := claim.New()
		if err != nil {
			t.Fatal(err)
		}

		if len(c) != 9 || c[4] != '-' {
			t.Fatalf("code = %q, want XXXX-XXXX", c)
		}

		for _, r := range strings.ReplaceAll(c, "-", "") {
			if !strings.ContainsRune(claim.Alphabet, r) {
				t.Fatalf("code %q contains %q, outside the alphabet", c, r)
			}
		}

		seen[c] = true
	}

	// Codes are single-use, so a generator that repeats itself inside 200 draws
	// is broken rather than unlucky.
	if len(seen) < 195 {
		t.Fatalf("only %d distinct codes in 200 draws", len(seen))
	}
}

func TestAlphabetExcludesConfusables(t *testing.T) {
	for _, r := range "01OILU5SBZ" {
		if strings.ContainsRune(claim.Alphabet, r) {
			t.Fatalf("alphabet contains the confusable %q", r)
		}
	}
}
