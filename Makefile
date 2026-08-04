.PHONY: help

help:
	@grep -E "^[a-zA-Z_-]+:.*?## " $(MAKEFILE_LIST) | awk -F ":.*?## " "{printf \"%-20s %s\\n\", \$$1, \$$2}"
