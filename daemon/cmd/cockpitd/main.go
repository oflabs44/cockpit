// Command cockpitd is the cockpit daemon: it dials out to the plane, reports
// what is on the box, and executes nothing in this build.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/client"
	"github.com/oflabs44/cockpit/daemon/internal/config"
	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/executor/dockercli"
	"github.com/oflabs44/cockpit/daemon/internal/executor/oscli"
	"github.com/oflabs44/cockpit/daemon/internal/observer"
	"github.com/oflabs44/cockpit/daemon/internal/ops"
)

// version is stamped at build time by the Makefile.
var version = "dev"

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "cockpitd:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		foreground = flag.Bool("foreground", false, "run in the terminal, logging to stdout, rather than as a systemd unit")
		plane      = flag.String("plane", "", "plane base URL, e.g. https://cockpit.oflabs.dev")
		token      = flag.String("token", "", "enrolment token, used once on a daemon that holds no credential")
		cfgPath    = flag.String("config", config.DefaultPath(), "path to the daemon config file")
		showVer    = flag.Bool("version", false, "print the version and exit")
	)

	flag.Parse()

	if *showVer {
		fmt.Println(version)

		return nil
	}

	log := newLogger(*foreground)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}

	if *plane != "" {
		cfg.Plane = *plane
	}

	if cfg.Plane == "" {
		return errors.New("no plane URL: pass --plane")
	}

	hostname, err := os.Hostname()
	if err != nil {
		return err
	}

	hostCLI := oscli.New(log)
	docker := dockercli.New(log)
	set := executor.Set{
		Docker:   docker,
		Host:     hostCLI,
		Firewall: hostCLI,
		Systemd:  hostCLI,
		Cron:     hostCLI,
	}

	c := &client.Client{
		PlaneURL: cfg.Plane,
		Identity: client.Identity{
			AgentVersion: version,
			Arch:         runtime.GOARCH,
			Hostname:     hostname,
		},
		Observer:        observer.New(set, time.Now).WithLogger(log),
		Ops:             &ops.Runner{Docker: docker},
		Dial:            client.WSDialer,
		Log:             log,
		EnrolmentSecret: *token,
		Credential:      cfg.Credential,
		ServerID:        cfg.ServerID,
		Backoff: client.Backoff{
			Base:   time.Second,
			Max:    2 * time.Minute,
			Factor: 2,
			Jitter: rand.Float64,
		},
		SnapshotInterval: 30 * time.Second,
		ClaimTTL:         10 * time.Minute,
		Out:              os.Stdout,
		OnCredential: func(serverID, credential string) error {
			cfg.ServerID = serverID
			cfg.Credential = credential

			return config.Save(*cfgPath, cfg)
		},
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if !filepath.IsAbs(*cfgPath) {
		log.Warn("config path is relative to the working directory; pass --config for a stable location", "config", *cfgPath)
	}

	log.Info("cockpitd starting", "version", version, "plane", cfg.Plane, "config", *cfgPath)

	err = c.Run(ctx)

	if errors.Is(err, context.Canceled) {
		log.Info("cockpitd stopping", "reason", "signal")

		return nil
	}

	return err
}

func newLogger(foreground bool) *slog.Logger {
	if foreground {
		return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}

	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
}
