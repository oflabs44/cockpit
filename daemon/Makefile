BIN     := cockpitd
PKG     := ./cmd/cockpitd
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
GOFLAGS := -trimpath
SHELLCHECK_IMAGE := koalaman/shellcheck:stable
TOKEN_ARG = $(if $(TOKEN),--token $(TOKEN),)

# Where make daemon-push sends the binary (docs/development.md section 3).
BOX ?= lab-nbg1
ARCH ?= arm64

.PHONY: help build test test-race lint fmt vet shellcheck tidy clean dist push run

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-12s %s\n", $$1, $$2}'

build: ## build cockpitd for this machine into bin/
	CGO_ENABLED=0 go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o bin/$(BIN) $(PKG)

test: ## tier 1 tests: no network, no docker
	go test ./...

test-race: ## tier 1 tests under the race detector
	go test -race ./...

lint: fmt vet shellcheck ## gofmt check, go vet, and shellcheck install.sh

fmt:
	@test -z "$$(gofmt -l .)" || { echo "gofmt needed:"; gofmt -l .; exit 1; }

vet:
	go vet ./...

# install.sh is piped into a root shell on other people's boxes, so it is
# linted with everything else rather than by hand. Prefers a local shellcheck,
# falls back to the container, and skips with a word when neither is here: a
# lint target that cannot run must not fail a build it never checked.
shellcheck: ## shellcheck install.sh, using docker when shellcheck is not installed
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck install.sh; \
	elif command -v docker >/dev/null 2>&1; then \
		docker run --rm -v "$$PWD:/mnt" $(SHELLCHECK_IMAGE) /mnt/install.sh; \
	else \
		echo "skipping shellcheck: install it, or docker, to lint install.sh"; \
	fi

tidy:
	go mod tidy

dist: ## cross-compile static release binaries for linux/amd64 and linux/arm64
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o dist/$(BIN)-linux-amd64 $(PKG)
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o dist/$(BIN)-linux-arm64 $(PKG)

push: dist ## copy the linux/$(ARCH) binary to $(BOX) over your own ssh, not cockpit's
	scp dist/$(BIN)-linux-$(ARCH) $(BOX):~/$(BIN)

run: build ## run in the foreground against a plane: make run PLANE=... TOKEN=...
	./bin/$(BIN) --foreground --plane $(PLANE) $(TOKEN_ARG)

clean:
	rm -rf bin dist
