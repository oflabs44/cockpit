package executor

import (
	"context"
	"errors"
)

// ErrNotImplemented is returned by executors whose implementation this slice
// deliberately omits.
var ErrNotImplemented = errors.New("executor: not implemented in this build")

// StubFirewall satisfies Firewall without touching the host.
type StubFirewall struct{}

func (StubFirewall) ListRules(context.Context) ([]FirewallRule, error) {
	return nil, ErrNotImplemented
}

// StubSystemd satisfies Systemd without touching the host.
type StubSystemd struct{}

func (StubSystemd) ListUnits(context.Context) ([]Unit, error) {
	return nil, ErrNotImplemented
}

// StubCron satisfies Cron without touching the host.
type StubCron struct{}

func (StubCron) ListEntries(context.Context) ([]CronEntry, error) {
	return nil, ErrNotImplemented
}
