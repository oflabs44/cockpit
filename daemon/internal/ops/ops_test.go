package ops_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/executor/fake"
	"github.com/oflabs44/cockpit/daemon/internal/ops"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

func spec() protocol.AppSpec {
	return protocol.AppSpec{
		Image:   "nginx:1.27",
		Ports:   []protocol.Port{{Container: 80, Host: 8080, Protocol: "tcp"}},
		Env:     map[string]string{"LOG_LEVEL": "info"},
		Labels:  map[string]string{"traefik.enable": "true"},
		Restart: "unless-stopped",
		Limits:  protocol.Limits{CPU: "1.0", Memory: "512m"},
	}
}

func target() protocol.Target {
	return protocol.Target{Kind: "app", Name: "web", Spec: spec()}
}

func newRunner() (*ops.Runner, *fake.Docker) {
	d := &fake.Docker{}

	return &ops.Runner{Docker: d}, d
}

func apply(t *testing.T, r *ops.Runner, c protocol.Change) string {
	t.Helper()

	changed, err := r.Apply(context.Background(), c)
	if err != nil {
		t.Fatalf("apply %s: %v", c.Op, err)
	}

	return changed
}

func createChange() protocol.Change {
	tgt := target()

	return protocol.Change{Op: protocol.OpResourceCreate, Target: "res_1", After: &tgt}
}

// TestCreateIsIdempotent is invariant 5: a task re-sent after a reconnect
// produces no_op, not a duplicate resource.
func TestCreateIsIdempotent(t *testing.T) {
	r, docker := newRunner()

	if got := apply(t, r, createChange()); got != protocol.ChangedCreate {
		t.Fatalf("first apply = %q, want create", got)
	}

	if got := apply(t, r, createChange()); got != protocol.ChangedNoOp {
		t.Fatalf("second apply = %q, want no_op", got)
	}

	if len(docker.Containers) != 1 {
		t.Fatalf("containers = %d, want 1", len(docker.Containers))
	}

	if len(docker.Ran) != 1 {
		t.Fatalf("ran docker run %d times, want 1", len(docker.Ran))
	}

	run := docker.Ran[0]

	// The spec is passed through, plus the label that records what it was.
	if run.Image != "nginx:1.27" || run.Restart != "unless-stopped" || run.CPU != "1.0" || run.Memory != "512m" {
		t.Fatalf("run spec = %+v", run)
	}

	if run.Env["LOG_LEVEL"] != "info" || run.Labels["traefik.enable"] != "true" {
		t.Fatalf("env/labels = %+v / %+v", run.Env, run.Labels)
	}

	if run.Labels[ops.SpecLabel] != ops.SpecHash(spec()) {
		t.Fatalf("spec label = %q", run.Labels[ops.SpecLabel])
	}

	// The daemon holds no desired state: the spec label on the box is what
	// makes the second run a no_op.
	if run.Ports[0].Host != 8080 {
		t.Fatalf("ports = %+v", run.Ports)
	}
}

func TestUpdateReplacesOnlyWhenTheSpecChanged(t *testing.T) {
	r, docker := newRunner()

	apply(t, r, createChange())

	changed := target()
	changed.Spec.Image = "nginx:1.28"

	update := protocol.Change{Op: protocol.OpResourceUpdate, Target: "res_1", After: &changed}

	if got := apply(t, r, update); got != protocol.ChangedReplace {
		t.Fatalf("changed spec = %q, want replace", got)
	}

	// Replace is remove-then-create: a container's image cannot be edited.
	if strings.Join(docker.Ops, " ") != "run web remove web run web" {
		t.Fatalf("ops = %v", docker.Ops)
	}

	if got := apply(t, r, update); got != protocol.ChangedNoOp {
		t.Fatalf("re-applying the same update = %q, want no_op", got)
	}

	if len(docker.Containers) != 1 || docker.Containers[0].Image != "nginx:1.28" {
		t.Fatalf("containers = %+v", docker.Containers)
	}
}

func TestEnsureStartsAStoppedContainerInPlace(t *testing.T) {
	r, docker := newRunner()

	apply(t, r, createChange())

	if err := docker.Stop(context.Background(), "web"); err != nil {
		t.Fatal(err)
	}

	// Right spec, wrong state: start it rather than rebuild it.
	if got := apply(t, r, createChange()); got != protocol.ChangedInPlace {
		t.Fatalf("stopped container = %q, want in_place", got)
	}

	if got := apply(t, r, createChange()); got != protocol.ChangedNoOp {
		t.Fatalf("second apply = %q, want no_op", got)
	}

	if len(docker.Ran) != 1 {
		t.Fatalf("container was rebuilt: ran %d times", len(docker.Ran))
	}
}

func TestDeleteIsIdempotent(t *testing.T) {
	r, docker := newRunner()

	apply(t, r, createChange())

	before := target()
	del := protocol.Change{Op: protocol.OpResourceDelete, Target: "res_1", Before: &before}

	if got := apply(t, r, del); got != protocol.ChangedInPlace {
		t.Fatalf("first delete = %q, want in_place", got)
	}

	if got := apply(t, r, del); got != protocol.ChangedNoOp {
		t.Fatalf("second delete = %q, want no_op", got)
	}

	if len(docker.Containers) != 0 {
		t.Fatalf("containers = %+v, want none", docker.Containers)
	}
}

func TestDirectStartStopAreIdempotent(t *testing.T) {
	r, docker := newRunner()

	apply(t, r, createChange())

	ctx := context.Background()

	// Already running.
	if got, err := r.Direct(ctx, "start", "web"); err != nil || got != protocol.ChangedNoOp {
		t.Fatalf("start on a running container = %q, %v", got, err)
	}

	if got, err := r.Direct(ctx, "stop", "web"); err != nil || got != protocol.ChangedInPlace {
		t.Fatalf("first stop = %q, %v", got, err)
	}

	if got, err := r.Direct(ctx, "stop", "web"); err != nil || got != protocol.ChangedNoOp {
		t.Fatalf("second stop = %q, %v", got, err)
	}

	if got, err := r.Direct(ctx, "start", "web"); err != nil || got != protocol.ChangedInPlace {
		t.Fatalf("start on a stopped container = %q, %v", got, err)
	}

	if docker.Containers[0].State != "running" {
		t.Fatalf("state = %q, want running", docker.Containers[0].State)
	}
}

// A restart is the one op that is not a no_op the second time: asking for two
// restarts means two restarts, and reporting the second as no_op would be a
// lie about what happened to the box.
func TestRestartAlwaysActs(t *testing.T) {
	r, docker := newRunner()

	apply(t, r, createChange())

	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if got, err := r.Direct(ctx, "restart", "web"); err != nil || got != protocol.ChangedInPlace {
			t.Fatalf("restart %d = %q, %v", i, got, err)
		}
	}

	if n := strings.Count(strings.Join(docker.Ops, " "), "restart web"); n != 2 {
		t.Fatalf("restarted %d times, want 2", n)
	}
}

func TestDirectRefusesUnknownActionsAndMissingContainers(t *testing.T) {
	r, _ := newRunner()
	ctx := context.Background()

	if _, err := r.Direct(ctx, "start", "nope"); err == nil {
		t.Fatal("starting a container that does not exist should fail")
	}

	apply(t, r, createChange())

	if _, err := r.Direct(ctx, "exec", "web"); err == nil {
		t.Fatal("exec is not one of the three direct actions")
	}
}

func TestApplyRefusesWhatItCannotExecute(t *testing.T) {
	r, docker := newRunner()
	ctx := context.Background()

	db := protocol.Target{Kind: "database", Name: "pg", Spec: spec()}

	if _, err := r.Apply(ctx, protocol.Change{Op: protocol.OpResourceCreate, After: &db}); err == nil {
		t.Fatal("only the app kind is executable in this slice")
	}

	for _, op := range []string{"server.drain", "release.rollback", "daemon.upgrade", "link.create"} {
		tgt := target()

		if _, err := r.Apply(ctx, protocol.Change{Op: op, After: &tgt}); err == nil {
			t.Fatalf("op %q should be refused, not guessed at", op)
		}
	}

	if _, err := r.Apply(ctx, protocol.Change{Op: protocol.OpResourceCreate}); err == nil {
		t.Fatal("a create with no after state should fail")
	}

	// Nothing was touched by any of the refusals.
	if len(docker.Ops) != 0 {
		t.Fatalf("refused ops still mutated the box: %v", docker.Ops)
	}
}

func TestApplyPropagatesDockerFailure(t *testing.T) {
	r, docker := newRunner()
	boom := errors.New("no space left on device")
	docker.RunErr = boom

	if _, err := r.Apply(context.Background(), createChange()); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the docker failure", err)
	}
}

// An absent map and an empty one mean the same thing. If they hashed
// differently, a plane that omitted an empty env would destroy and rebuild a
// live container on a spec that did not change.
func TestSpecHashTreatsNilAndEmptyAlike(t *testing.T) {
	nilFields := protocol.AppSpec{Image: "nginx:1.27"}
	emptyFields := protocol.AppSpec{
		Image:  "nginx:1.27",
		Env:    map[string]string{},
		Labels: map[string]string{},
		Ports:  []protocol.Port{},
	}

	if ops.SpecHash(nilFields) != ops.SpecHash(emptyFields) {
		t.Fatal("nil and empty fields hash differently, so an unchanged spec would replace")
	}
}

func TestSpecHashIsPortOrderInvariant(t *testing.T) {
	a := spec()
	a.Ports = []protocol.Port{{Container: 80, Host: 8080, Protocol: "tcp"}, {Container: 443, Host: 8443, Protocol: "tcp"}}

	b := spec()
	b.Ports = []protocol.Port{{Container: 443, Host: 8443, Protocol: "tcp"}, {Container: 80, Host: 8080, Protocol: "tcp"}}

	if ops.SpecHash(a) != ops.SpecHash(b) {
		t.Fatal("port order changes the hash, so a reordered list would replace")
	}

	c := spec()
	c.Ports = []protocol.Port{{Container: 80, Host: 9090, Protocol: "tcp"}}

	if ops.SpecHash(a) == ops.SpecHash(c) {
		t.Fatal("a different port must change the hash")
	}
}

func TestUnchangedSpecWithOmittedEmptiesIsANoOp(t *testing.T) {
	r, docker := newRunner()

	bare := protocol.Target{Kind: "app", Name: "web", Spec: protocol.AppSpec{Image: "nginx:1.27"}}
	create := protocol.Change{Op: protocol.OpResourceCreate, After: &bare}

	if got := apply(t, r, create); got != protocol.ChangedCreate {
		t.Fatalf("first apply = %q", got)
	}

	// The same spec arriving with its empty collections spelled out.
	explicit := protocol.Target{Kind: "app", Name: "web", Spec: protocol.AppSpec{
		Image: "nginx:1.27", Env: map[string]string{}, Labels: map[string]string{}, Ports: []protocol.Port{},
	}}

	if got := apply(t, r, protocol.Change{Op: protocol.OpResourceUpdate, After: &explicit}); got != protocol.ChangedNoOp {
		t.Fatalf("second apply = %q, want no_op — the live container was rebuilt for nothing", got)
	}

	if len(docker.Ran) != 1 {
		t.Fatalf("ran %d times, want 1", len(docker.Ran))
	}
}

func TestFailedRemoveAbortsBeforeAnyRun(t *testing.T) {
	r, docker := newRunner()

	apply(t, r, createChange())

	changed := target()
	changed.Spec.Image = "nginx:1.28"

	docker.RemoveErr = errors.New("device or resource busy")

	_, err := r.Apply(context.Background(), protocol.Change{Op: protocol.OpResourceUpdate, After: &changed})
	if err == nil {
		t.Fatal("a failed remove must fail the change")
	}

	// The old container is still there and no new one was started over it.
	if len(docker.Ran) != 1 || len(docker.Containers) != 1 {
		t.Fatalf("ran = %d, containers = %+v", len(docker.Ran), docker.Containers)
	}
}

func TestFailedRunAfterRemoveSaysTheContainerIsGone(t *testing.T) {
	r, docker := newRunner()

	apply(t, r, createChange())

	changed := target()
	changed.Spec.Image = "nginx:1.28"

	docker.RunErr = errors.New("manifest unknown")

	_, err := r.Apply(context.Background(), protocol.Change{Op: protocol.OpResourceUpdate, After: &changed})
	if err == nil {
		t.Fatal("want an error")
	}

	// The operator has to know the box is now running nothing under this name.
	if !strings.Contains(err.Error(), "old container removed") || !strings.Contains(err.Error(), "web") {
		t.Fatalf("err = %v", err)
	}
}

func TestSpecHashIgnoresMapOrder(t *testing.T) {
	a := spec()
	a.Env = map[string]string{"A": "1", "B": "2"}

	b := spec()
	b.Env = map[string]string{"B": "2", "A": "1"}

	if ops.SpecHash(a) != ops.SpecHash(b) {
		t.Fatal("hash depends on map iteration order, so ensure would replace forever")
	}

	c := spec()
	c.Env = map[string]string{"A": "1", "B": "3"}

	if ops.SpecHash(a) == ops.SpecHash(c) {
		t.Fatal("a changed env value must change the hash")
	}
}

// The executor seam is the whole test surface: no docker anywhere here.
var _ executor.Docker = (*fake.Docker)(nil)
