.PHONY: help install plane-dev plane-test plane-typecheck plane-migrate web-dev web-build web-typecheck

help:
	@grep -E "^[a-zA-Z_-]+:.*?## " $(MAKEFILE_LIST) | awk -F ":.*?## " "{printf \"%-20s %s\\n\", \$$1, \$$2}"

install: ## install workspace dependencies
	pnpm install

plane-dev: web-build ## run the plane Worker in dev mode (serves the built UI via the assets binding)
	pnpm --filter @oflabs44/cockpit-plane dev

plane-test: ## run the plane's test suite
	pnpm --filter @oflabs44/cockpit-plane test

plane-typecheck: ## typecheck the plane
	pnpm --filter @oflabs44/cockpit-plane typecheck

plane-migrate: ## apply D1 migrations to the plane's local dev database
	pnpm --filter @oflabs44/cockpit-plane migrate

web-dev: ## run the web UI in dev mode (proxies API paths to `wrangler dev` on :8787)
	pnpm --filter @oflabs44/cockpit-web dev

web-build: ## build the web UI's static assets for the plane's assets binding
	pnpm --filter @oflabs44/cockpit-web build

web-typecheck: ## typecheck the web UI
	pnpm --filter @oflabs44/cockpit-web typecheck
