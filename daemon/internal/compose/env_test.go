package compose

// The environment Compose runs with. It is the same list on the box and inside
// the sandbox, so what a repository's document interpolates while the model is
// produced is what it interpolates while the stack is applied — and neither
// side can interpolate anything the daemon happened to be started with.

import (
	"context"
	"os"
	"strings"
	"testing"
)

// The list itself, spelled out here rather than read from the package, so a
// variable can only be added to what Compose sees deliberately.
var wantEnv = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/nonexistent",
	"DOCKER_CONFIG=/nonexistent/docker",
	"TMPDIR=/tmp",
}

func TestComposeEnvIsFixed(t *testing.T) {
	if got := strings.Join(composeEnv(), "\n"); got != strings.Join(wantEnv, "\n") {
		t.Fatalf("env =\n%s\nwant\n%s", got, strings.Join(wantEnv, "\n"))
	}
}

// The daemon's own environment is not the deployment's. A secret in the process
// that started the daemon must not reach a Compose command, on either side.
func TestComposeEnvDoesNotInheritTheDaemonEnvironment(t *testing.T) {
	const secret = "cockpit-daemon-secret-value"

	t.Setenv("COCKPIT_TEST_SECRET", secret)
	t.Setenv("GITHUB_TOKEN", secret)

	for _, variable := range composeEnv() {
		if strings.Contains(variable, secret) {
			t.Fatalf("the daemon environment leaked into the command: %q", variable)
		}
	}

	for _, arg := range sandboxRun("/checkout", "c", []string{"compose", "config"}) {
		if strings.Contains(arg, secret) {
			t.Fatalf("the daemon environment leaked into the sandbox: %q", arg)
		}
	}
}

// The sandbox is handed exactly the host environment, in order. A variable one
// side has and the other does not is a model that differs from what apply runs.
func TestSandboxGetsTheSameEnvironmentAsTheHost(t *testing.T) {
	var inSandbox []string

	args := sandboxRun("/checkout", "c", nil)
	for i, arg := range args {
		if arg == "--env" && i+1 < len(args) {
			inSandbox = append(inSandbox, args[i+1])
		}
	}

	if strings.Join(inSandbox, " ") != strings.Join(composeEnv(), " ") {
		t.Fatalf("sandbox env =\n%s\nhost env\n%s",
			strings.Join(inSandbox, "\n"), strings.Join(composeEnv(), "\n"))
	}
}

// What a command actually runs with, read out of the process rather than
// asserted about the code that builds it. Both runners are checked: normalizing
// goes through one, building, migrating, and applying through the other.
func TestCommandsRunWithTheFixedEnvironment(t *testing.T) {
	if _, err := os.Stat("/usr/bin/env"); err != nil {
		t.Skip("no /usr/bin/env to read the environment back from")
	}

	t.Setenv("COCKPIT_TEST_SECRET", "cockpit-daemon-secret-value")

	captured, err := execRun(context.Background(), t.TempDir(), "/usr/bin/env")
	if err != nil {
		t.Fatal(err)
	}

	var streamed []byte

	err = execStream(context.Background(), t.TempDir(), "/usr/bin/env", nil, func(stream Stream, chunk []byte) {
		if stream == Stdout {
			streamed = append(streamed, chunk...)
		}
	})
	if err != nil {
		t.Fatal(err)
	}

	want := strings.Join(composeEnv(), "\n")

	for runner, out := range map[string][]byte{"exec": captured, "stream": streamed} {
		if got := strings.TrimRight(string(out), "\n"); got != want {
			t.Fatalf("%s env =\n%s\nwant\n%s", runner, got, want)
		}
	}
}
