package client_test

import (
	"context"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/executor/fake"
	"github.com/oflabs44/cockpit/daemon/internal/observer"
	"github.com/oflabs44/cockpit/daemon/internal/ops"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/client"
)

func appTarget(name, image string) protocol.Target {
	return protocol.Target{
		Kind: "app",
		Name: name,
		Spec: protocol.AppSpec{Image: image, Restart: "unless-stopped"},
	}
}

// executing returns a client wired to execute against an in-memory box, with
// the given plane frames scripted after the welcome.
func executing(t *testing.T, frames ...any) (*client.Client, *fakeTransport, *fake.Docker) {
	t.Helper()

	inbox := [][]byte{mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"})}
	for _, f := range frames {
		inbox = append(inbox, mustJSON(t, f))
	}

	tr := &fakeTransport{inbox: inbox}

	set, docker := fake.Set()

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"
	c.Observer = observer.New(set, func() time.Time { return time.Unix(42, 0) })
	c.Ops = &ops.Runner{Docker: docker}

	return c, tr, docker
}

func progressFrames(tr *fakeTransport) []map[string]any {
	var out []map[string]any

	for _, f := range tr.frames() {
		if f["type"] == protocol.TypeTaskProgress {
			out = append(out, f)
		}
	}

	return out
}

func TestTaskRunsChangesInOrderAndReportsEach(t *testing.T) {
	first := appTarget("web", "nginx:1.27")
	second := appTarget("api", "api:2")

	c, tr, docker := executing(t, protocol.Task{
		Type: protocol.TypeTask, TaskID: "tsk_1", PlanID: "pln_1",
		Changes: []protocol.Change{
			{Op: protocol.OpResourceCreate, Target: "res_1", After: &first},
			{Op: protocol.OpResourceCreate, Target: "res_2", After: &second},
		},
	})

	runOnce(t, c)

	progress := progressFrames(tr)

	if len(progress) != 4 {
		t.Fatalf("progress frames = %d, want started+ok per change: %+v", len(progress), progress)
	}

	for i, want := range []struct {
		index  float64
		status string
	}{{0, protocol.ProgressStarted}, {0, protocol.ProgressOK}, {1, protocol.ProgressStarted}, {1, protocol.ProgressOK}} {
		p := progress[i]

		if p["task_id"] != "tsk_1" || p["change_index"] != want.index || p["status"] != want.status {
			t.Fatalf("progress[%d] = %+v, want %v/%s", i, p, want.index, want.status)
		}
	}

	if progress[1]["changed"] != protocol.ChangedCreate {
		t.Fatalf("changed = %v, want create", progress[1]["changed"])
	}

	// Order matters: the plane sent web before api.
	if len(docker.Ops) != 2 || docker.Ops[0] != "run web" || docker.Ops[1] != "run api" {
		t.Fatalf("ops = %v", docker.Ops)
	}

	// A completed task forces a fresh snapshot rather than letting the plane
	// infer the result from the changes.
	last := tr.frames()[len(tr.frames())-1]

	if last["type"] != protocol.TypeState {
		t.Fatalf("last frame = %v, want a state snapshot", last["type"])
	}
}

func TestTaskStopsAtTheFirstFailure(t *testing.T) {
	bad := protocol.Target{Kind: "database", Name: "pg"}
	good := appTarget("api", "api:2")

	c, tr, docker := executing(t, protocol.Task{
		Type: protocol.TypeTask, TaskID: "tsk_1", PlanID: "pln_1",
		Changes: []protocol.Change{
			{Op: protocol.OpResourceCreate, Target: "res_1", After: &bad},
			{Op: protocol.OpResourceCreate, Target: "res_2", After: &good},
		},
	})

	runOnce(t, c)

	progress := progressFrames(tr)

	if len(progress) != 2 {
		t.Fatalf("progress frames = %d, want the failed change only: %+v", len(progress), progress)
	}

	if progress[1]["status"] != protocol.ProgressError {
		t.Fatalf("status = %v, want error", progress[1]["status"])
	}

	if progress[1]["changed"] != nil {
		t.Fatalf("a failed change reported changed = %v", progress[1]["changed"])
	}

	frameErr, _ := progress[1]["error"].(map[string]any)

	if frameErr["kind"] != "execute" || frameErr["message"] == "" {
		t.Fatalf("error = %+v", frameErr)
	}

	// The second change never ran: later changes assume the box is in the
	// state the plan was computed for.
	if len(docker.Ops) != 0 {
		t.Fatalf("ops = %v, want nothing applied", docker.Ops)
	}

	// The snapshot still goes out: the plane must see where the box actually
	// stopped.
	if last := tr.frames()[len(tr.frames())-1]; last["type"] != protocol.TypeState {
		t.Fatalf("last frame = %v, want a state snapshot", last["type"])
	}
}

func TestOpExecutesAndResyncs(t *testing.T) {
	c, tr, docker := executing(t, protocol.Op{
		Type: protocol.TypeOp, OpID: "op_1", EventID: "evt_1",
		Action: "restart", ResourceID: "res_1", Kind: "app", Name: "web",
	})

	if err := docker.Run(context.Background(), executorRunSpec("web")); err != nil {
		t.Fatal(err)
	}

	runOnce(t, c)

	if got := docker.Ops[len(docker.Ops)-1]; got != "restart web" {
		t.Fatalf("ops = %v, want a restart", docker.Ops)
	}

	result := opResult(t, tr)

	if result["op_id"] != "op_1" || result["changed"] != protocol.ChangedInPlace || result["error"] != nil {
		t.Fatalf("op_result = %+v", result)
	}

	// Rule 3.3: an op completing triggers a fresh state snapshot.
	if last := tr.frames()[len(tr.frames())-1]; last["type"] != protocol.TypeState {
		t.Fatalf("last frame = %v, want a state snapshot", last["type"])
	}
}

// An op may never carry a spec change — that restriction is what keeps the
// direct-operation carve-out from being a loophole (ADR-0003, invariant 1).
func TestOpCarryingASpecChangeIsRefused(t *testing.T) {
	for _, field := range []string{"spec", "after", "before", "changes", "plan_id"} {
		frame := map[string]any{
			"type": protocol.TypeOp, "op_id": "op_1", "event_id": "evt_1",
			"action": "restart", "resource_id": "res_1", "kind": "app", "name": "web",
			field: map[string]any{"image": "nginx:evil"},
		}

		c, tr, docker := executing(t, frame)

		if err := docker.Run(context.Background(), executorRunSpec("web")); err != nil {
			t.Fatal(err)
		}

		before := len(docker.Ops)

		runOnce(t, c)

		if len(docker.Ops) != before {
			t.Fatalf("op carrying %q mutated the box: %v", field, docker.Ops[before:])
		}

		// Refused, and answered: a plane waiting on this op must not be left
		// unable to tell a refusal from a dead daemon.
		result := opResult(t, tr)

		if result["op_id"] != "op_1" || result["changed"] != nil {
			t.Fatalf("op_result = %+v", result)
		}

		frameErr, _ := result["error"].(map[string]any)

		if frameErr["kind"] != protocol.ErrRefused {
			t.Fatalf("error = %+v, want a refusal", frameErr)
		}
	}
}

func TestOpWithoutANameIsRefused(t *testing.T) {
	c, tr, docker := executing(t, protocol.Op{
		Type: protocol.TypeOp, OpID: "op_1", EventID: "evt_1",
		Action: "restart", ResourceID: "res_1",
	})

	if err := docker.Run(context.Background(), executorRunSpec("web")); err != nil {
		t.Fatal(err)
	}

	before := len(docker.Ops)

	runOnce(t, c)

	// The daemon holds no plane resource ids, so a frame without a name names
	// nothing it can act on. Guessing would mutate the wrong container.
	if len(docker.Ops) != before {
		t.Fatalf("an unnameable op mutated the box: %v", docker.Ops[before:])
	}

	if frameErr, _ := opResult(t, tr)["error"].(map[string]any); frameErr["kind"] != protocol.ErrRefused {
		t.Fatalf("error = %+v, want a refusal", frameErr)
	}
}

func TestOpWithoutAnEventIDIsRefusedSilently(t *testing.T) {
	c, tr, docker := executing(t, protocol.Op{
		Type: protocol.TypeOp, OpID: "op_1", Action: "restart", Kind: "app", Name: "web",
	})

	if err := docker.Run(context.Background(), executorRunSpec("web")); err != nil {
		t.Fatal(err)
	}

	before := len(docker.Ops)

	runOnce(t, c)

	// An op is bound to a recorded Event; one naming none is not executed, and
	// there is nothing meaningful to answer it with.
	if len(docker.Ops) != before {
		t.Fatalf("an unbound op mutated the box: %v", docker.Ops[before:])
	}

	for _, f := range tr.frames() {
		if f["type"] == protocol.TypeOpResult {
			t.Fatalf("answered an unbound op: %+v", f)
		}
	}
}

func TestTaskIsRefusedByAnObserveOnlyDaemon(t *testing.T) {
	target := appTarget("web", "nginx:1.27")

	c, tr, docker := executing(t, protocol.Task{
		Type: protocol.TypeTask, TaskID: "tsk_1", PlanID: "pln_1",
		Changes: []protocol.Change{{Op: protocol.OpResourceCreate, After: &target}},
	})

	c.Ops = nil

	runOnce(t, c)

	if len(docker.Ops) != 0 {
		t.Fatalf("ops = %v, want nothing", docker.Ops)
	}

	// A plan sitting in `applying` must never hang on the daemon's silence:
	// a refusal answers too.
	progress := progressFrames(tr)

	if len(progress) != 1 {
		t.Fatalf("progress = %+v, want one refusal", progress)
	}

	frameErr, _ := progress[0]["error"].(map[string]any)

	if progress[0]["status"] != protocol.ProgressError || frameErr["kind"] != protocol.ErrRefused {
		t.Fatalf("progress = %+v, want a refused error", progress[0])
	}

	if progress[0]["change_index"] != float64(0) {
		t.Fatalf("change_index = %v, want 0", progress[0]["change_index"])
	}
}

func TestTaskWithoutIdsIsRefused(t *testing.T) {
	target := appTarget("web", "nginx:1.27")

	c, tr, docker := executing(t, protocol.Task{
		Type: protocol.TypeTask, TaskID: "tsk_1",
		Changes: []protocol.Change{{Op: protocol.OpResourceCreate, After: &target}},
	})

	runOnce(t, c)

	// The enforceable half of "task is bound to a plan in applying": a task
	// naming no plan cannot be checked against one.
	if len(docker.Ops) != 0 {
		t.Fatalf("ops = %v, want nothing", docker.Ops)
	}

	progress := progressFrames(tr)

	if len(progress) != 1 || progress[0]["status"] != protocol.ProgressError {
		t.Fatalf("progress = %+v, want one refusal", progress)
	}
}

func executorRunSpec(name string) executor.RunSpec {
	return executor.RunSpec{Name: name, Image: "nginx:1.27"}
}

func TestFailedOpReportsTheError(t *testing.T) {
	c, tr, _ := executing(t, protocol.Op{
		Type: protocol.TypeOp, OpID: "op_1", EventID: "evt_1",
		Action: "restart", ResourceID: "res_1", Kind: "app", Name: "gone",
	})

	runOnce(t, c)

	// Without this the plane cannot tell a failed restart from a successful
	// no_op.
	result := opResult(t, tr)

	frameErr, _ := result["error"].(map[string]any)

	if result["changed"] != nil || frameErr["kind"] != "execute" {
		t.Fatalf("op_result = %+v", result)
	}
}

// opResult returns the single op_result frame the daemon sent.
func opResult(t *testing.T, tr *fakeTransport) map[string]any {
	t.Helper()

	var found []map[string]any

	for _, f := range tr.frames() {
		if f["type"] == protocol.TypeOpResult {
			found = append(found, f)
		}
	}

	if len(found) != 1 {
		t.Fatalf("op_result frames = %d, want exactly 1: %+v", len(found), found)
	}

	return found[0]
}
