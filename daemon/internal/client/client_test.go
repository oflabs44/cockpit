package client_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/client"
	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/executor/fake"
	"github.com/oflabs44/cockpit/daemon/internal/observer"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// fakeTransport replays scripted plane frames and records what was sent.
type fakeTransport struct {
	mu     sync.Mutex
	inbox  [][]byte
	sent   [][]byte
	closed bool
}

func (t *fakeTransport) Send(_ context.Context, b []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sent = append(t.sent, append([]byte(nil), b...))

	return nil
}

func (t *fakeTransport) Recv(context.Context) ([]byte, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if len(t.inbox) == 0 {
		return nil, io.EOF
	}

	b := t.inbox[0]
	t.inbox = t.inbox[1:]

	return b, nil
}

func (t *fakeTransport) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true

	return nil
}

func (t *fakeTransport) frames() []map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()

	out := make([]map[string]any, 0, len(t.sent))

	for _, b := range t.sent {
		var m map[string]any

		if err := json.Unmarshal(b, &m); err != nil {
			panic(err)
		}

		out = append(out, m)
	}

	return out
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()

	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}

	return b
}

func newClient(t *testing.T, tr *fakeTransport) *client.Client {
	t.Helper()

	set, docker := fake.Set()
	docker.Set([]executor.Container{{ID: "c1", Name: "web", State: "running"}})

	return &client.Client{
		PlaneURL: "https://plane.test",
		Identity: client.Identity{AgentVersion: "test", Arch: "arm64", Hostname: "lab-nbg1"},
		Observer: observer.New(set, func() time.Time { return time.Unix(42, 0) }),
		Dial: func(context.Context, string) (client.Transport, error) {
			return tr, nil
		},
		Sleep: func(context.Context, time.Duration) error { return nil },
		Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestEnrolmentExchangePersistsCredential(t *testing.T) {
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1", Credential: "ck_cred_live"}),
	}}

	c := newClient(t, tr)
	c.EnrolmentSecret = "ck_enrol_once"

	var gotServer, gotCred string
	c.OnCredential = func(serverID, credential string) error {
		gotServer, gotCred = serverID, credential

		return nil
	}

	runOnce(t, c)

	frames := tr.frames()

	if len(frames) != 2 {
		t.Fatalf("sent %d frames, want hello + state: %+v", len(frames), frames)
	}

	hello := frames[0]

	if hello["type"] != protocol.TypeHello {
		t.Fatalf("first frame = %v, want hello", hello["type"])
	}

	auth, _ := hello["auth"].(map[string]any)

	if auth["kind"] != protocol.AuthEnrolment || auth["secret"] != "ck_enrol_once" {
		t.Fatalf("auth = %+v, want enrolment secret", auth)
	}

	if hello["hostname"] != "lab-nbg1" || hello["arch"] != "arm64" {
		t.Fatalf("hello identity = %+v", hello)
	}

	if gotServer != "srv_1" || gotCred != "ck_cred_live" {
		t.Fatalf("persisted (%q, %q), want (srv_1, ck_cred_live)", gotServer, gotCred)
	}

	if c.EnrolmentSecret != "" {
		t.Fatal("enrolment secret was not burned after use")
	}

	state := frames[1]

	if state["type"] != protocol.TypeState || state["rev"].(float64) != 1 {
		t.Fatalf("second frame = %+v, want state rev 1", state)
	}

	resources, _ := state["resources"].([]any)

	if len(resources) != 1 {
		t.Fatalf("state carried %d resources, want 1", len(resources))
	}
}

func TestCredentialAuthWhenAlreadyEnrolled(t *testing.T) {
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"}),
	}}

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"
	c.ServerID = "srv_1"
	c.OnCredential = func(string, string) error {
		t.Fatal("credential re-persisted on an already-enrolled daemon")

		return nil
	}

	runOnce(t, c)

	hello := tr.frames()[0]
	auth, _ := hello["auth"].(map[string]any)

	if auth["kind"] != protocol.AuthCredential || auth["secret"] != "ck_cred_live" {
		t.Fatalf("auth = %+v, want credential", auth)
	}

	if hello["server_id"] != "srv_1" {
		t.Fatalf("server_id = %v, want srv_1", hello["server_id"])
	}
}

func TestHandshakeRejectsFrameBeforeWelcome(t *testing.T) {
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, map[string]any{"type": protocol.TypePing}),
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"}),
	}}

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"

	runOnce(t, c)

	// Until the handshake succeeds the connection may do nothing but enrol:
	// no state, no pong (type-design section 3.3).
	for _, f := range tr.frames()[1:] {
		t.Fatalf("frame sent before welcome: %+v", f)
	}
}

// A daemon with neither a credential nor a token enters the claim-code flow
// rather than failing; see claim_test.go.

func TestPingIsAnsweredWithPong(t *testing.T) {
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"}),
		mustJSON(t, map[string]any{"type": protocol.TypePing}),
	}}

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"

	runOnce(t, c)

	frames := tr.frames()

	if len(frames) != 3 || frames[2]["type"] != protocol.TypePong {
		t.Fatalf("frames = %+v, want hello, state, pong", frames)
	}
}

func TestUnknownFrameIsIgnored(t *testing.T) {
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"}),
		mustJSON(t, map[string]any{"type": "task", "task_id": "t1"}),
		mustJSON(t, map[string]any{"type": protocol.TypePing}),
	}}

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"

	runOnce(t, c)

	frames := tr.frames()

	// This build executes nothing: the task is dropped, the ping still answered.
	if len(frames) != 3 || frames[2]["type"] != protocol.TypePong {
		t.Fatalf("frames = %+v, want hello, state, pong", frames)
	}
}

func TestReconnectBacksOffAndResendsFullState(t *testing.T) {
	conns := []*fakeTransport{
		{},
		{},
		{inbox: [][]byte{mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"})}},
		{inbox: [][]byte{mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"})}},
	}

	var (
		dialErrs = []error{errors.New("dial 1"), errors.New("dial 2"), nil, nil}
		dialed   int
		slept    []time.Duration
	)

	c := newClient(t, conns[0])
	c.Credential = "ck_cred_live"
	c.Backoff = client.Backoff{Base: time.Second, Max: 8 * time.Second, Factor: 2}
	c.Dial = func(context.Context, string) (client.Transport, error) {
		i := dialed
		dialed++

		if i >= len(conns) {
			return nil, errors.New("no more connections")
		}

		if dialErrs[i] != nil {
			return nil, dialErrs[i]
		}

		return conns[i], nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	c.Sleep = func(context.Context, time.Duration) error { return nil }

	// Stop the loop once every scripted connection has been used.
	c.Sleep = func(_ context.Context, d time.Duration) error {
		slept = append(slept, d)

		if dialed >= len(conns) {
			cancel()

			return context.Canceled
		}

		return nil
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	if want := []time.Duration{time.Second, 2 * time.Second, time.Second, time.Second}; !equalDurations(slept, want) {
		t.Fatalf("backoff sequence = %v, want %v (reset after a successful handshake)", slept, want)
	}

	// Every connection that got through the handshake resends a full snapshot,
	// with a fresh rev: the plane reconciles rather than assuming continuity.
	for i, tr := range conns[2:] {
		frames := tr.frames()

		if len(frames) != 2 || frames[1]["type"] != protocol.TypeState {
			t.Fatalf("connection %d frames = %+v, want hello + state", i+2, frames)
		}

		if got, want := frames[1]["rev"].(float64), float64(i+1); got != want {
			t.Fatalf("connection %d state rev = %v, want %v", i+2, got, want)
		}
	}
}

// deadDocker answers the connect snapshot and then fails, as dockerd dying
// under a connected daemon does.
type deadDocker struct {
	mu    sync.Mutex
	calls int
}

func (d *deadDocker) ListContainers(context.Context) ([]executor.Container, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls++

	if d.calls == 1 {
		return nil, nil
	}

	return nil, errors.New("cannot connect to the docker daemon")
}

func (d *deadDocker) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()

	return d.calls
}

func TestRepeatedSnapshotFailuresEndTheSession(t *testing.T) {
	docker := &deadDocker{}
	set, _ := fake.Set()
	set.Docker = docker

	// The connection is healthy and would hold open forever; only the failure
	// budget can end it, which is the point — a box the daemon cannot observe
	// must stop looking connected.
	tr := &blockingTransport{fakeTransport: fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"}),
	}}}

	c := newClient(t, nil)
	c.Dial = func(context.Context, string) (client.Transport, error) { return tr, nil }
	c.Credential = "ck_cred_live"
	c.Observer = observer.New(set, func() time.Time { return time.Unix(42, 0) })
	c.SnapshotInterval = time.Millisecond

	if err := onceErr(t, c); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want the session to have ended", err)
	}

	// One good connect snapshot plus the three consecutive failures that spend
	// the budget.
	if got := docker.count(); got != 4 {
		t.Fatalf("observed %d times, want 4 (connect + 3 failures)", got)
	}
}

func TestDaemonURL(t *testing.T) {
	cases := map[string]string{
		"https://cockpit.oflabs.dev":       "wss://cockpit.oflabs.dev/daemon",
		"https://cockpit.oflabs.dev/":      "wss://cockpit.oflabs.dev/daemon",
		"http://localhost:8787":            "ws://localhost:8787/daemon",
		"wss://cockpit-dev.workers.dev":    "wss://cockpit-dev.workers.dev/daemon",
		"https://plane.test/base?x=1#frag": "wss://plane.test/base/daemon",
	}

	for in, want := range cases {
		got, err := client.DaemonURL(in)
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}

		if got != want {
			t.Fatalf("%s -> %s, want %s", in, got, want)
		}
	}

	for _, bad := range []string{"cockpit.oflabs.dev", "ftp://x.test", ""} {
		if _, err := client.DaemonURL(bad); err == nil {
			t.Fatalf("%q: want error", bad)
		}
	}
}

// runOnce drives exactly one session: the scripted transport ends in EOF,
// which stops the loop through the cancelling Sleep.
func runOnce(t *testing.T, c *client.Client) {
	t.Helper()

	if err := onceErr(t, c); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}
}

func onceErr(t *testing.T, c *client.Client) error {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c.Sleep = func(context.Context, time.Duration) error {
		cancel()

		return context.Canceled
	}

	return c.Run(ctx)
}

func equalDurations(a, b []time.Duration) bool {
	if len(a) != len(b) {
		return false
	}

	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}

	return true
}
