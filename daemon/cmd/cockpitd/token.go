package main

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"strings"

	"github.com/oflabs44/cockpit/daemon/internal/config"
)

// --token-file exists because argv is world-readable through /proc, and a
// token written into a systemd unit outlives the single use it was issued for.
func resolveToken(token, tokenFile string, log *slog.Logger) (string, error) {
	if token != "" && tokenFile != "" {
		return "", errors.New("pass --token or --token-file, not both")
	}

	if tokenFile == "" {
		return token, nil
	}

	b, err := os.ReadFile(tokenFile)

	// The file is unlinked when the token is burned, so a restart after a
	// successful enrolment finds nothing here.
	if errors.Is(err, fs.ErrNotExist) {
		log.Info("no enrolment token file; it was burned or never written", "path", tokenFile)

		return "", nil
	}

	if err != nil {
		return "", err
	}

	token = strings.TrimSpace(string(b))

	// Not the same as no file, which means burned: falling through to the claim
	// flow would print a code at whoever is waiting for an enrolment.
	if token == "" {
		return "", fmt.Errorf("enrolment token file %s is empty", tokenFile)
	}

	return token, nil
}

// The order is the point: a crash between the write and the burn costs a token
// the plane has already spent, while burning first costs the box its identity.
func persistCredential(cfgPath string, cfg *config.File, tokenFile string, log *slog.Logger) func(string, string) error {
	return func(serverID, credential string) error {
		cfg.ServerID = serverID
		cfg.Credential = credential

		if err := config.Save(cfgPath, *cfg); err != nil {
			return err
		}

		burnTokenFile(tokenFile, log)

		return nil
	}
}

// A daemon holding a credential prefers it forever, so this token will never
// be presented and must not sit on disk for the life of the box. An install.sh
// run that died before its own cleanup leaves one.
func discardUnusableToken(cfg config.File, enrolment, tokenFile string, log *slog.Logger) string {
	if cfg.Credential == "" || enrolment == "" {
		return enrolment
	}

	log.Info("discarding an enrolment token this daemon will never present: it already holds a credential")
	burnTokenFile(tokenFile, log)

	return ""
}

func burnTokenFile(path string, log *slog.Logger) {
	if path == "" {
		return
	}

	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Warn("could not remove the spent enrolment token file", "path", path, "err", err)

		return
	}

	log.Info("enrolment token burned", "path", path)
}
