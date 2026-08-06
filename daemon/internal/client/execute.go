package client

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// opSpecKeys are the fields that would make an op frame a spec change. An op
// leaves the spec identical by definition (ADR-0003); one carrying any of
// these is refused rather than executed, and that refusal is what keeps the
// direct-operation carve-out from being a loophole.
var opSpecKeys = []string{"spec", "after", "before", "changes", "plan_id"}

// handleTask runs a plan's changes in order, reporting each.
//
// It stops at the first failure. The plane owns the decision to retry or
// revert, and every op is idempotent, so a re-sent task resumes safely —
// whereas continuing past a failed change would apply later changes against a
// box that is not in the state the plan was computed for.
//
// Every refusal answers too: a plan sitting in `applying` must never hang on
// the daemon's silence.
func (c *Client) handleTask(ctx context.Context, tr Transport, raw []byte) error {
	var t protocol.Task

	if err := json.Unmarshal(raw, &t); err != nil {
		c.log().Warn("undecodable task frame", "err", err)

		// No task_id to answer under, so the plane learns of this from the
		// version-skew log rather than a frame addressed to nothing.
		return nil
	}

	if t.TaskID == "" || t.PlanID == "" {
		return c.refuseTask(ctx, tr, t.TaskID, "task must name both a task_id and the plan it belongs to")
	}

	c.log().Info("task received", "task_id", t.TaskID, "plan_id", t.PlanID, "changes", len(t.Changes))

	if c.Ops == nil {
		return c.refuseTask(ctx, tr, t.TaskID, "this daemon has no executor wired")
	}

	inFlight := -1

	defer func() {
		if inFlight >= 0 && ctx.Err() != nil {
			c.log().Error("connection ended with a change in flight; the box may have been left mid-change",
				"task_id", t.TaskID, "change_index", inFlight, "err", ctx.Err())
		}
	}()

	for i, change := range t.Changes {
		if err := send(ctx, tr, protocol.TaskProgress{
			Type: protocol.TypeTaskProgress, TaskID: t.TaskID, ChangeIndex: i, Status: protocol.ProgressStarted,
		}); err != nil {
			c.log().Error("task aborted mid-flight: could not report progress",
				"task_id", t.TaskID, "change_index", i, "err", err)

			return err
		}

		inFlight = i
		changed, err := c.Ops.Apply(ctx, change)
		inFlight = -1

		progress := protocol.TaskProgress{
			Type: protocol.TypeTaskProgress, TaskID: t.TaskID, ChangeIndex: i,
			Status: protocol.ProgressOK, Changed: changed,
		}

		if err != nil {
			c.log().Error("change failed", "task_id", t.TaskID, "change_index", i, "op", change.Op, "err", err)

			progress.Status = protocol.ProgressError
			progress.Changed = ""
			progress.Error = &protocol.FrameError{Kind: "execute", Message: err.Error()}
		} else {
			c.log().Info("change applied", "task_id", t.TaskID, "change_index", i, "op", change.Op, "changed", changed)
		}

		if sendErr := send(ctx, tr, progress); sendErr != nil {
			c.log().Error("task aborted mid-flight: could not report the change's outcome",
				"task_id", t.TaskID, "change_index", i, "changed", changed, "err", sendErr)

			return sendErr
		}

		if err != nil {
			break
		}
	}

	// A completed task leaves the box somewhere new, so the plane is told what
	// is actually there rather than inferring it from the changes.
	return c.sendSnapshot(ctx, tr)
}

// refuseTask answers a task the daemon will not run, at change_index 0.
func (c *Client) refuseTask(ctx context.Context, tr Transport, taskID, reason string) error {
	c.log().Error("refusing task", "task_id", taskID, "reason", reason)

	if taskID == "" {
		return nil
	}

	return send(ctx, tr, protocol.TaskProgress{
		Type: protocol.TypeTaskProgress, TaskID: taskID, ChangeIndex: 0,
		Status: protocol.ProgressError,
		Error:  &protocol.FrameError{Kind: protocol.ErrRefused, Message: reason},
	})
}

// handleOp runs one direct operation: restart, stop or start. Every outcome —
// executed, failed, or refused — answers with an op_result.
func (c *Client) handleOp(ctx context.Context, tr Transport, raw []byte) error {
	var o protocol.Op

	if err := json.Unmarshal(raw, &o); err != nil {
		c.log().Warn("undecodable op frame", "err", err)

		return nil
	}

	if o.OpID == "" || o.EventID == "" {
		c.log().Error("refusing op frame that names no op_id or event_id", "op_id", o.OpID, "event_id", o.EventID)

		// An op is bound to a recorded Event; one naming neither has nothing
		// to answer to and nothing to be attributed to.
		return nil
	}

	if key, found := carriesSpec(raw); found {
		return c.refuseOp(ctx, tr, o.OpID, fmt.Sprintf("op frames may not carry a spec change; this one has %q", key))
	}

	if o.Name == "" {
		return c.refuseOp(ctx, tr, o.OpID,
			"op names no resource name, and this daemon holds no plane resource ids")
	}

	if o.Kind != "" && o.Kind != "app" {
		return c.refuseOp(ctx, tr, o.OpID, fmt.Sprintf("this daemon cannot execute kind %q", o.Kind))
	}

	if c.Ops == nil {
		return c.refuseOp(ctx, tr, o.OpID, "this daemon has no executor wired")
	}

	changed, err := c.Ops.Direct(ctx, o.Action, o.Name)

	result := protocol.OpResult{Type: protocol.TypeOpResult, OpID: o.OpID, Changed: changed}

	if err != nil {
		c.log().Error("op failed", "op_id", o.OpID, "event_id", o.EventID,
			"action", o.Action, "name", o.Name, "err", err)

		result.Changed = ""
		result.Error = &protocol.FrameError{Kind: "execute", Message: err.Error()}
	} else {
		c.log().Info("op applied", "op_id", o.OpID, "event_id", o.EventID,
			"action", o.Action, "name", o.Name, "changed", changed)
	}

	if sendErr := send(ctx, tr, result); sendErr != nil {
		return sendErr
	}

	// Rule 3.3: an op completing triggers a fresh snapshot, so divergence is
	// detected now rather than at the next planner run.
	return c.sendSnapshot(ctx, tr)
}

// refuseOp answers an op the daemon will not run.
func (c *Client) refuseOp(ctx context.Context, tr Transport, opID, reason string) error {
	c.log().Error("refusing op", "op_id", opID, "reason", reason)

	return send(ctx, tr, protocol.OpResult{
		Type: protocol.TypeOpResult, OpID: opID,
		Error: &protocol.FrameError{Kind: protocol.ErrRefused, Message: reason},
	})
}

// carriesSpec reports whether an op frame contains a field that would make it
// a spec change.
func carriesSpec(raw []byte) (string, bool) {
	var fields map[string]json.RawMessage

	if err := json.Unmarshal(raw, &fields); err != nil {
		return "", false
	}

	for _, key := range opSpecKeys {
		if _, ok := fields[key]; ok {
			return key, true
		}
	}

	return "", false
}
