package client

import (
	"fmt"
	"os"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/claim"
)

// defaultClaimTTL keeps a printed code short-lived without making an operator
// who walked away re-run anything: they read whatever code is on screen.
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

// claimRemaining is what is left of the printed code's life, measured from
// when it was generated rather than from the start of this session.
func (c *Client) claimRemaining() time.Duration {
	return c.claimTTL() - c.now().Sub(c.claimIssuedAt)
}

// expireClaim drops a code that has aged out. rejectClaim drops one the plane
// answered without binding: either way the next wait generates a fresh one
// rather than reprinting a code a form would reject.
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

// ensureClaimCode returns the code currently on offer, generating one if this
// is the first wait or the previous code has run out of life.
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

	return code, nil
}

// printClaim writes the block an operator reads immediately after install.sh
// finishes. It goes to stdout rather than the log because it is the first
// thing cockpit ever says to them.
func (c *Client) printClaim() {
	w := c.Out
	if w == nil {
		w = os.Stdout
	}

	fmt.Fprintf(w, `
cockpit

  cockpitd is installed and running on %s.
  This server is not yet bound to a plane.

  Claim code   %s
  Plane        %s

  Redeem the code in your cockpit client to bind this server.
  It expires in %s; a new one is printed here when it does.

`, c.Identity.Hostname, c.claimCode, c.PlaneURL, humanDuration(c.claimRemaining()))
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
