// Package claim generates the short code an operator types into a cockpit
// client to bind a box that was installed without an enrolment token
// (CONTEXT.md, architecture section 3.1).
package claim

import (
	"crypto/rand"
	"math/big"
	"strings"
)

// Alphabet omits the characters that get misread off a terminal and mistyped
// into a form: 0/O, 1/I/L, U/V, and S/5. What is left is unambiguous read
// aloud over a phone as well as copied by eye.
const Alphabet = "234679ACDEFGHJKMNPQRTWXY"

const (
	groupLen   = 4
	groupCount = 2
)

// New returns a code in XXXX-XXXX form. 24^8 is roughly 1.1e11, which is only
// safe because codes are short-lived and the plane rate-limits redemption
// (type-design section 2.1.1).
func New() (string, error) {
	var b strings.Builder

	for g := 0; g < groupCount; g++ {
		if g > 0 {
			b.WriteByte('-')
		}

		for i := 0; i < groupLen; i++ {
			n, err := rand.Int(rand.Reader, big.NewInt(int64(len(Alphabet))))
			if err != nil {
				return "", err
			}

			b.WriteByte(Alphabet[n.Int64()])
		}
	}

	return b.String(), nil
}
