.PHONY: help install plane-dev plane-test plane-typecheck plane-migrate

help:
	@grep -E "^[a-zA-Z_-]+:.*?## " $(MAKEFILE_LIST) | awk -F ":.*?## " "{printf \"%-20s %s\\n\", \$$1, \$$2}"

install: ## install workspace dependencies
	pnpm install

plane-dev: ## run the plane Worker in dev mode
	pnpm --filter @oflabs44/cockpit-plane dev

plane-test: ## run the plane's test suite
	pnpm --filter @oflabs44/cockpit-plane test

plane-typecheck: ## typecheck the plane
	pnpm --filter @oflabs44/cockpit-plane typecheck

plane-migrate: ## apply D1 migrations to the plane's local dev database
	pnpm --filter @oflabs44/cockpit-plane migrate
