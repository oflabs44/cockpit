// Package client is the daemon's side of the plane connection: dial out,
// enrol or authenticate, report a full state snapshot, and reconnect with
// exponential backoff (type-design section 3).
package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/observer"
	"github.com/oflabs44/cockpit/daemon/internal/ops"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// Transport is one plane connection. Injected so the state machine is testable
// with no network.
type Transport interface {
	Send(ctx context.Context, b []byte) error
	Recv(ctx context.Context) ([]byte, error)
	Close() error
}

// Dialer opens a Transport to the plane's /daemon endpoint, presenting secret
// in the upgrade request.
type Dialer func(ctx context.Context, url, secret string) (Transport, error)

// Identity is what the daemon reports about itself in hello.
type Identity struct {
	AgentVersion string
	Arch         string
	Hostname     string
}

// ErrUnauthenticated means the plane rejected or never completed the
// handshake. Until it succeeds the connection may do nothing but enrol
// (type-design section 3.3).
var ErrUnauthenticated = errors.New("plane did not complete the handshake")

// ErrClaimExpired means the printed claim code aged out before the operator
// redeemed it. The daemon prints a fresh one and waits again; it is the normal
// course of a box left sitting after install, not a failure.
var ErrClaimExpired = errors.New("claim code expired before it was redeemed")

// Plane close codes (apps/plane/src/durable-objects/server-do.ts).
const (
	closeTokenRace    = 4006 // another connection claimed this token first
	closeClaimExpired = 4007 // this claim code is no longer pending
)

// Client runs the connection lifecycle.
type Client struct {
	PlaneURL string
	Identity Identity
	Observer *observer.Observer
	// Ops executes task and op frames. Nil means an observe-only daemon,
	// which refuses both.
	Ops     *ops.Runner
	Dial    Dialer
	Backoff Backoff
	Log     *slog.Logger

	// EnrolmentSecret is presented once, on a daemon that holds no credential.
	EnrolmentSecret string
	// Credential and ServerID are the long-lived pair, empty until enrolled.
	Credential string
	ServerID   string

	// OnCredential persists a credential issued by the plane. Called before any
	// further frame is sent, so a crash mid-session cannot lose it. A failure
	// is sticky: the daemon keeps serving on the credential it holds and
	// retries the persist at the start of every session until it lands,
	// because the secret that produced it is already burned plane-side.
	OnCredential func(serverID, credential string) error

	// NewClaimCode generates the code an unbound daemon prints and presents.
	// Nil uses claim.New.
	NewClaimCode func() (string, error)
	// ClaimTTL is how long a printed code is offered before a fresh one is
	// generated and printed. Codes are short-lived by design (minutes).
	ClaimTTL time.Duration
	// Out is where the operator-facing claim block is written. Nil means
	// os.Stdout. It is not the log: this is what a human reads seconds after
	// install.sh finishes.
	Out io.Writer

	// SnapshotInterval re-sends a full state snapshot while connected.
	SnapshotInterval time.Duration
	// Sleep is injected so reconnect tests do not wait. Nil uses a timer.
	Sleep func(ctx context.Context, d time.Duration) error
	// Now is injected so claim-code expiry is testable. Nil uses time.Now.
	Now func() time.Time

	// claimCode is the code currently printed and on offer, with the wall-clock
	// time it was generated. Expiry is measured against that, not against a
	// per-session timeout: a code the plane has already expired must not get a
	// fresh clock every time a flaky connection redials.
	claimCode     string
	claimIssuedAt time.Time

	// unsaved is set when the plane issued an identity that is not yet on disk.
	unsaved bool
}

// Run dials, serves, and redials until ctx is done. A daemon holding neither a
// credential nor an enrolment token enters the claim-code flow: it prints a
// code and waits to be bound (architecture section 3.1).
func (c *Client) Run(ctx context.Context) error {
	for {
		err := c.session(ctx)

		if ctx.Err() != nil {
			return ctx.Err()
		}

		// An expired claim code is the expected outcome of waiting, not a
		// failing connection, so it does not push the backoff out.
		if errors.Is(err, ErrClaimExpired) {
			c.Backoff.Reset()
		}

		d := c.Backoff.Next()
		c.log().Warn("connection ended, reconnecting", "err", err, "in", d)

		if err := c.sleep(ctx, d); err != nil {
			return err
		}
	}
}

// session is one connection: dial, handshake, snapshot, serve.
func (c *Client) session(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	c.persistIdentity()

	// The same secret goes in the upgrade header and in hello: the plane
	// resolves the daemon from the header before choosing a Durable Object,
	// then validates the two against each other.
	secret, err := c.secret()
	if err != nil {
		return err
	}

	tr, err := c.Dial(ctx, c.PlaneURL, secret)
	if err != nil {
		c.logDialReject(err)

		return fmt.Errorf("dial: %w", err)
	}

	defer tr.Close()

	if err := c.handshake(ctx, tr); err != nil {
		return err
	}

	c.Backoff.Reset()
	c.log().Info("connected", "server_id", c.ServerID)

	// A full snapshot on every connect: the plane reconciles rather than
	// assuming continuity (type-design section 3.3).
	if err := c.sendSnapshot(ctx, tr); err != nil {
		return err
	}

	return c.serve(ctx, cancel, tr)
}

// claiming reports whether this daemon has neither a credential nor an
// enrolment token, and must therefore print a claim code and wait to be bound.
func (c *Client) claiming() bool {
	return c.Credential == "" && c.EnrolmentSecret == ""
}

// secret is what this daemon presents, in the upgrade header and in hello.
func (c *Client) secret() (string, error) {
	if c.Credential != "" {
		return c.Credential, nil
	}

	if c.EnrolmentSecret != "" {
		return c.EnrolmentSecret, nil
	}

	return c.ensureClaimCode()
}

// logDialReject names the plane's refusals, which otherwise read as identical
// dial failures. None of them invalidates the secret: a 409 in particular
// means another socket already holds this claim code, so reprinting a new one
// would send the operator chasing a code the plane is not waiting on.
func (c *Client) logDialReject(err error) {
	var se *StatusError

	if !errors.As(err, &se) {
		return
	}

	switch se.Status {
	case http.StatusTooManyRequests:
		c.log().Warn("plane rate limited this connection, backing off")
	case http.StatusConflict:
		c.log().Warn("another connection is already pending on this claim code, backing off",
			"claim_code", c.claimCode)
	}
}

// handshake sends hello and waits for the plane's welcome, persisting a
// credential if this was an enrolment or a claim.
func (c *Client) handshake(ctx context.Context, tr Transport) error {
	// The same secret the upgrade header carried. Prefixes (ck_cred_, ck_enrol_)
	// are the plane's and the operator's; the daemon passes them through
	// untouched, and an unprefixed secret is its own claim code.
	secret, err := c.secret()
	if err != nil {
		return err
	}

	auth := protocol.Auth{Kind: protocol.AuthEnrolment, Secret: secret}
	if c.Credential != "" {
		auth.Kind = protocol.AuthCredential
	}

	hello := protocol.Hello{
		Type:         protocol.TypeHello,
		AgentVersion: c.Identity.AgentVersion,
		Arch:         c.Identity.Arch,
		Hostname:     c.Identity.Hostname,
		Auth:         auth,
		ServerID:     c.ServerID,
	}

	if err := send(ctx, tr, hello); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	waitCtx := ctx

	if c.claiming() {
		if err := send(ctx, tr, protocol.AwaitingClaim{Type: protocol.TypeAwaitingClaim, Code: c.claimCode}); err != nil {
			return fmt.Errorf("send awaiting_claim: %w", err)
		}

		c.printClaim()

		// The operator may take minutes to redeem, so the wait is bounded by
		// what is left of this code's life — not by a fresh timeout per
		// session, which would keep a plane-expired code alive on a flaky link.
		var cancel context.CancelFunc

		waitCtx, cancel = context.WithTimeout(ctx, c.claimRemaining())
		defer cancel()
	}

	b, err := tr.Recv(waitCtx)
	if err != nil {
		switch CloseCode(err) {
		case closeTokenRace:
			// Another connection presented the same token first. The plane
			// resolves the winner; this daemon simply retries.
			c.log().Warn("lost a race for this enrolment token to another connection")

			return fmt.Errorf("await welcome: %w", err)
		case closeClaimExpired:
			c.log().Warn("claim code expired between connect and hello, generating a new one")
			c.expireClaim()

			return ErrClaimExpired
		}

		// Only the code's own deadline expires it. A connection that merely
		// dropped keeps the code the operator is looking at.
		if c.claiming() && waitCtx.Err() != nil && ctx.Err() == nil {
			c.expireClaim()

			return ErrClaimExpired
		}

		return fmt.Errorf("await welcome: %w", err)
	}

	down, err := protocol.DecodeDown(b)
	if err != nil {
		return err
	}

	if down.Type != protocol.TypeWelcome {
		// The plane answered and did not bind us, so the code it saw is spent:
		// printing it again would send the operator to a form that rejects it.
		c.rejectClaim("plane answered the claim with " + down.Type)

		return fmt.Errorf("%w: first frame was %q", ErrUnauthenticated, down.Type)
	}

	var w protocol.Welcome

	if err := json.Unmarshal(down.Raw, &w); err != nil {
		c.rejectClaim("welcome was undecodable")

		return err
	}

	if w.ServerID == "" {
		c.rejectClaim("welcome carried no server_id")

		return fmt.Errorf("%w: welcome carried no server_id", ErrUnauthenticated)
	}

	// A daemon is bound to exactly one server for its lifetime. Being handed a
	// different id is a plane-side mix-up, and continuing would report this
	// box's containers as another server's.
	if c.ServerID != "" && c.ServerID != w.ServerID {
		return fmt.Errorf("%w: plane returned server_id %q but this daemon is bound to %q",
			ErrUnauthenticated, w.ServerID, c.ServerID)
	}

	changed := c.ServerID != w.ServerID
	c.ServerID = w.ServerID

	if w.Credential != "" && w.Credential != c.Credential {
		c.Credential = w.Credential
		changed = true
	}

	// Anything the plane told us about our own identity has to reach disk,
	// including a server_id learned without a new credential.
	if changed && c.Credential != "" {
		c.unsaved = true
		c.persistIdentity()
	}

	return nil
}

// persistIdentity writes the plane-issued identity to disk and, only once that
// succeeds, burns the secret that produced it. A failure leaves `unsaved` set
// so the next session tries again: the daemon can still serve on the in-memory
// credential, but a restart before this lands would orphan the box.
func (c *Client) persistIdentity() {
	if !c.unsaved {
		return
	}

	if c.OnCredential != nil {
		if err := c.OnCredential(c.ServerID, c.Credential); err != nil {
			c.log().Error("credential not persisted; this box is orphaned if it restarts before it lands",
				"err", err, "server_id", c.ServerID)

			return
		}
	}

	c.unsaved = false
	// Burned only now: the secret is worthless plane-side, but until the
	// credential is on disk it is the only record that this happened.
	c.EnrolmentSecret = ""
	c.claimCode = ""

	c.log().Info("enrolled", "server_id", c.ServerID)
}

// serve reads plane frames until the connection ends. This slice executes
// nothing: it answers ping and re-snapshots on an interval.
func (c *Client) serve(ctx context.Context, cancel context.CancelFunc, tr Transport) error {
	if c.SnapshotInterval > 0 {
		stop := make(chan struct{})
		defer close(stop)

		go c.snapshotLoop(ctx, cancel, tr, stop)
	}

	for {
		b, err := tr.Recv(ctx)
		if err != nil {
			return err
		}

		down, err := protocol.DecodeDown(b)
		if err != nil {
			c.log().Warn("undecodable frame", "err", err)

			continue
		}

		switch down.Type {
		case protocol.TypePing:
			if err := send(ctx, tr, protocol.Pong{Type: protocol.TypePong}); err != nil {
				return err
			}
		case protocol.TypeTask:
			if err := c.handleTask(ctx, tr, down.Raw); err != nil {
				return err
			}
		case protocol.TypeOp:
			if err := c.handleOp(ctx, tr, down.Raw); err != nil {
				return err
			}
		default:
			// Version skew is expected during development, so say so loudly
			// rather than failing obscurely (docs/development.md section 5).
			c.log().Warn("ignoring frame this daemon does not implement", "type", down.Type)
		}
	}
}

// maxSnapshotFailures is how many consecutive failed snapshots end the
// session. A daemon that cannot observe its box must stop looking connected:
// the plane's last good snapshot would otherwise stand as current forever.
// Three is one transient hiccup's worth of tolerance and no more.
const maxSnapshotFailures = 3

func (c *Client) snapshotLoop(ctx context.Context, end context.CancelFunc, tr Transport, stop <-chan struct{}) {
	t := time.NewTicker(c.SnapshotInterval)
	defer t.Stop()

	failures := 0

	for {
		select {
		case <-ctx.Done():
			return
		case <-stop:
			return
		case <-t.C:
			err := c.sendSnapshot(ctx, tr)
			if err == nil {
				failures = 0

				continue
			}

			failures++
			c.log().Warn("snapshot failed", "err", err, "consecutive", failures)

			if failures >= maxSnapshotFailures {
				c.log().Error("cannot observe this box, dropping the connection", "err", err)
				end()

				return
			}
		}
	}
}

func (c *Client) sendSnapshot(ctx context.Context, tr Transport) error {
	st, err := c.Observer.Snapshot(ctx)
	if err != nil {
		return fmt.Errorf("observe: %w", err)
	}

	if err := send(ctx, tr, st); err != nil {
		return fmt.Errorf("send state: %w", err)
	}

	c.log().Info("state sent", "rev", st.Rev, "resources", len(st.Resources))

	return nil
}

func (c *Client) sleep(ctx context.Context, d time.Duration) error {
	if c.Sleep != nil {
		return c.Sleep(ctx, d)
	}

	t := time.NewTimer(d)
	defer t.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (c *Client) log() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}

	return slog.Default()
}

func send(ctx context.Context, tr Transport, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}

	return tr.Send(ctx, b)
}
