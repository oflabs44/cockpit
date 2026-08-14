package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/client"
	"github.com/oflabs44/cockpit/daemon/internal/config"
)

// A variable only so the tests can point it somewhere they may write.
var rootStatePath = config.RootStatePath

// `claim` treats no state as a failure and `status` as an answer, so it must
// be distinguishable from a file that could not be read for another reason.
var errNoState = errors.New("the daemon has published no state")

func runClaim(args []string, out io.Writer, now func() time.Time) error {
	flags := flag.NewFlagSet("claim", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	statePath := flags.String("state", config.StatePath(), "path to the daemon runtime state file")

	if err := flags.Parse(args); err != nil {
		// -h already printed the usage; the flag package would report it again
		// as an error and exit non-zero.
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}

		return err
	}

	chosen := false

	flags.Visit(func(f *flag.Flag) {
		if f.Name == "state" {
			chosen = true
		}
	})

	st, err := loadState(*statePath, chosen, "claim")
	if err != nil {
		return err
	}

	// The same test `status` uses, so the two cannot disagree about whether the
	// code on the box can still be redeemed.
	if !claimLive(st, now()) {
		if st.State == config.StateConnected {
			fmt.Fprintf(out, "\ncockpit\n\n  %s is already bound to %s as %s.\n  There is no claim code to redeem.\n\n",
				st.Hostname, st.Plane, st.ServerID)

			return nil
		}

		return fmt.Errorf("no claim code is on offer on %s right now.\n"+
			"  cockpitd publishes a fresh one within a minute of the last expiring; if it does not,\n"+
			"  it is not reaching %s: journalctl -u cockpitd -n 50", st.Hostname, st.Plane)
	}

	fmt.Fprint(out, client.ClaimBlock(st.Hostname, st.ClaimCode, st.Plane, time.Unix(st.ClaimExpiresAt, 0).Sub(now())))

	return nil
}

// config.StatePath() branches on the *reader's* euid, so without the fallback
// an operator running this unprivileged is told a healthy box is not running,
// having looked in their home directory for a file the daemon writes to /run.
func loadState(path string, chosen bool, command string) (config.State, error) {
	st, err := config.LoadState(path)
	if err == nil {
		return st, nil
	}

	if errors.Is(err, fs.ErrPermission) {
		return config.State{}, sudoError(path, command)
	}

	if !errors.Is(err, fs.ErrNotExist) {
		return config.State{}, err
	}

	if chosen || path == rootStatePath {
		return config.State{}, notRunningError(path)
	}

	st, rootErr := config.LoadState(rootStatePath)

	switch {
	case rootErr == nil:
		return st, nil
	case errors.Is(rootErr, fs.ErrPermission):
		return config.State{}, sudoError(rootStatePath, command)
	default:
		// The root path, not the per-user one this reader defaulted to: that
		// is where a daemon publishes, and where systemd removed the whole
		// directory when the unit stopped. Naming the other one sends the
		// operator to a file nothing has ever written.
		return config.State{}, notRunningError(rootStatePath)
	}
}

// loadState is shared, so the subcommand is named rather than assumed.
func sudoError(path, command string) error {
	return fmt.Errorf("cannot read %s: the daemon publishes it as root.\n"+
		"  Run: sudo cockpitd %s", path, command)
}

func notRunningError(path string) error {
	return fmt.Errorf("no daemon state at %s: cockpitd is not running, or has not reached the plane yet.\n"+
		"  Check it with: journalctl -u cockpitd -n 50 (%w)", path, errNoState)
}
