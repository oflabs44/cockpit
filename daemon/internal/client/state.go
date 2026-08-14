package client

import (
	"github.com/oflabs44/cockpit/daemon/internal/config"
)

// The expiry is measured from when the code was generated, not from now:
// `cockpitd claim` must count down the same clock the daemon is waiting on.
// The code is passed in so that what lands in the file is the code the
// connection was keyed on, not whatever the field holds by then.
func (c *Client) publishAwaitingClaim(code string) {
	c.claimPresented = true

	c.publish(config.State{
		State:          config.StateAwaitingClaim,
		ClaimCode:      code,
		ClaimExpiresAt: c.claimIssuedAt.Add(c.claimTTL()).Unix(),
	})
}

// Silent while a redeemable code is standing: an unbound daemon between
// redials is still offering what is on the operator's screen, and only the
// code's own deadline retires it.
func (c *Client) publishDisconnected() {
	if c.offeringClaim() {
		return
	}

	c.publishNotConnected()
}

func (c *Client) publishNotConnected() {
	s := config.State{State: config.StateDisconnected}

	// A server_id present means bound, everywhere this file is read.
	if !c.claiming() {
		s.ServerID = c.ServerID
	}

	c.publish(s)
}

// A code generated for a dial that never landed is redeemable by nobody, so it
// must not keep the file quiet.
func (c *Client) offeringClaim() bool {
	if !c.claiming() {
		return false
	}

	return c.claimPresented && c.claimCode != "" && c.claimRemaining() > 0
}

func (c *Client) publishConnected() {
	c.publish(config.State{
		State:    config.StateConnected,
		ServerID: c.ServerID,
	})
}

func (c *Client) publish(s config.State) {
	if c.PublishState == nil {
		return
	}

	s.Plane = c.PlaneURL
	s.Hostname = c.Identity.Hostname
	s.HasEnrolmentToken = c.EnrolmentSecret != ""

	if err := c.PublishState(s); err != nil {
		c.log().Warn("could not publish runtime state; `cockpitd claim` will not see this", "err", err, "state", s.State)
	}
}
