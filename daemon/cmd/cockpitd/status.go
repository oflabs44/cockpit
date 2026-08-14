package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/config"
)

// The whole answer to "what is going on with this box", computed here rather
// than in install.sh: the shell used to derive it from the same two files, and
// its idea of "enrolled" drifted from the daemon's often enough to strand
// servers.
const (
	// Enrolled, but the daemon is saying nothing: stopped, or not that far yet.
	DispositionUnknown = "unknown"
	// No credential on disk and no live claim code on offer.
	DispositionNotEnrolled   = "not_enrolled"
	DispositionAwaitingClaim = "awaiting_claim"
	DispositionConnected     = "connected"
	DispositionDisconnected  = "disconnected"
)

// Status is what `cockpitd status --json` emits.
type Status struct {
	Disposition string `json:"disposition"`
	// A credential on disk is the only kind there is: a daemon that cannot
	// write the one it was issued exits rather than run on it.
	Enrolled bool   `json:"enrolled"`
	ServerID string `json:"server_id,omitempty"`
	Plane    string `json:"plane,omitempty"`
	Hostname string `json:"hostname,omitempty"`
	Advice   string `json:"advice"`
}

// Both subcommands ask this, so `status` cannot call a code live while `claim`
// refuses to print it.
func claimLive(st config.State, now time.Time) bool {
	return st.State == config.StateAwaitingClaim &&
		st.ClaimCode != "" &&
		now.Before(time.Unix(st.ClaimExpiresAt, 0))
}

func statusOf(cfg config.File, st config.State, published bool, now time.Time) Status {
	s := Status{
		Enrolled: cfg.Credential != "",
		ServerID: cfg.ServerID,
		Plane:    cfg.Plane,
	}

	if published {
		s.Hostname = st.Hostname

		if st.Plane != "" {
			s.Plane = st.Plane
		}

		if st.ServerID != "" {
			s.ServerID = st.ServerID
		}
	}

	// What the daemon published wins over the absence of a credential: an
	// unenrolled daemon that has been refused by the plane is saying something
	// specific, and reporting it as not_enrolled tells the operator to do the
	// thing they have just done.
	switch {
	case published && claimLive(st, now):
		s.Disposition = DispositionAwaitingClaim
	case published && st.State == config.StateConnected:
		s.Disposition = DispositionConnected
	case published && st.State == config.StateDisconnected:
		s.Disposition = DispositionDisconnected
	case !s.Enrolled:
		s.Disposition = DispositionNotEnrolled
	default:
		s.Disposition = DispositionUnknown
	}

	s.Advice = advice[s.Disposition]

	// Only for a daemon actually presenting a token: an unreachable claim-code
	// box looks identical from here, and telling that operator to issue a fresh
	// token they were never given points away from the connectivity problem.
	if s.Disposition == DispositionDisconnected && !s.Enrolled && published && st.HasEnrolmentToken {
		s.Advice = "cockpitd cannot enrol: the plane refused its token, or is unreachable. The token" +
			" may be spent or expired — issue a fresh one. journalctl -u cockpitd -n 50"
	}

	return s
}

// One line each: anything longer belongs in the failure message of whatever
// refused, next to what actually went wrong.
var advice = map[string]string{
	DispositionAwaitingClaim: "Redeem the claim code in your cockpit client: sudo cockpitd claim",
	DispositionConnected:     "Nothing to do.",
	DispositionDisconnected:  "cockpitd cannot reach the plane: journalctl -u cockpitd -n 50",
	DispositionNotEnrolled:   "Enrol this server: run install.sh with a token, or redeem a claim code.",
	DispositionUnknown:       "cockpitd is not running or has published nothing: systemctl status cockpitd",
}

func runStatus(args []string, out io.Writer, now func() time.Time) error {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	asJSON := flags.Bool("json", false, "emit the status as JSON for another program to read")
	cfgPath := flags.String("config", config.DefaultPath(), "path to the daemon config file")
	statePath := flags.String("state", config.StatePath(), "path to the daemon runtime state file")

	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}

		return err
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}

	chosen := false

	flags.Visit(func(f *flag.Flag) {
		if f.Name == "state" {
			chosen = true
		}
	})

	st, published, err := readState(*statePath, chosen)
	if err != nil {
		return err
	}

	s := statusOf(cfg, st, published, now())

	if *asJSON {
		b, err := json.MarshalIndent(s, "", "  ")
		if err != nil {
			return err
		}

		fmt.Fprintf(out, "%s\n", b)

		return nil
	}

	fmt.Fprintf(out, "\ncockpit\n\n  %s\n  %s\n\n", summaryLine(s), s.Advice)

	return nil
}

func summaryLine(s Status) string {
	where := s.Hostname
	if where == "" {
		where = "this server"
	}

	switch s.Disposition {
	case DispositionAwaitingClaim:
		return fmt.Sprintf("%s is waiting to be claimed on %s.", where, s.Plane)
	case DispositionConnected:
		return fmt.Sprintf("%s is enrolled on %s as %s.", where, s.Plane, s.ServerID)
	case DispositionDisconnected:
		if !s.Enrolled {
			return fmt.Sprintf("%s is not enrolled and is not reaching %s.", where, s.Plane)
		}

		return fmt.Sprintf("%s is enrolled as %s but is not connected to %s.", where, s.ServerID, s.Plane)
	case DispositionNotEnrolled:
		return fmt.Sprintf("%s is not enrolled.", where)
	default:
		return fmt.Sprintf("%s has published nothing about itself.", where)
	}
}

// A missing file is an answer here rather than an error.
func readState(path string, chosen bool) (config.State, bool, error) {
	st, err := loadState(path, chosen, "status")

	switch {
	case err == nil:
		return st, true, nil
	case errors.Is(err, errNoState), errors.Is(err, fs.ErrNotExist):
		return config.State{}, false, nil
	default:
		return config.State{}, false, err
	}
}
