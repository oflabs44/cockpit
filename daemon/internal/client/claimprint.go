package client

import (
	"fmt"
	"os"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/claim"
)

const defaultClaimTTL = 10 * time.Minute

func (c *Client) claimTTL() time.Duration {
	if c.ClaimTTL > 0 {
		return c.ClaimTTL
	}

	return defaultClaimTTL
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}

	return time.Now()
}

// Measured from when the code was generated, not from the start of this
// session: a flaky link must not give a plane-expired code a fresh clock.
func (c *Client) claimRemaining() time.Duration {
	return c.claimTTL() - c.now().Sub(c.claimIssuedAt)
}

func (c *Client) expireClaim() {
	c.claimCode = ""
}

func (c *Client) rejectClaim(reason string) {
	if c.claimCode == "" {
		return
	}

	c.log().Warn("claim code rejected by the plane, generating a new one", "reason", reason)
	c.claimCode = ""
}

func (c *Client) ensureClaimCode() (string, error) {
	if c.claimCode != "" && c.claimRemaining() > 0 {
		return c.claimCode, nil
	}

	gen := c.NewClaimCode
	if gen == nil {
		gen = claim.New
	}

	code, err := gen()
	if err != nil {
		return "", fmt.Errorf("generate claim code: %w", err)
	}

	c.claimCode = code
	c.claimIssuedAt = c.now()
	// Not yet in front of the plane: what the last code earned does not carry.
	c.claimPresented = false

	return code, nil
}

// The one renderer: the running daemon and `cockpitd claim` both call it, and
// an operator who saw two different blocks for one code would have to work out
// which to believe.
func ClaimBlock(hostname, code, plane string, expiresIn time.Duration) string {
	return fmt.Sprintf(`
cockpit

  cockpitd is installed and running on %s.
  This server is not yet bound to a plane.

  Claim code   %s
  Plane        %s

  Redeem the code in your cockpit client to bind this server.
  It expires in %s; a new one is printed here when it does.

`, hostname, code, plane, humanDuration(expiresIn))
}

// Stdout rather than the log: it is the first thing cockpit says to an
// operator.
func (c *Client) printClaim(code string) {
	w := c.Out
	if w == nil {
		w = os.Stdout
	}

	fmt.Fprint(w, ClaimBlock(c.Identity.Hostname, code, c.PlaneURL, c.claimRemaining()))
}

func humanDuration(d time.Duration) string {
	if m := int(d.Minutes()); m >= 1 {
		if m == 1 {
			return "1 minute"
		}

		return fmt.Sprintf("%d minutes", m)
	}

	return d.String()
}
