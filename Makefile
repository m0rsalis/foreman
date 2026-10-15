NODE_TEST = node --experimental-strip-types --no-warnings --test

.PHONY: check test test-panel test-engine test-queue test-init test-tools lint typecheck preview

check: lint typecheck test ## Everything: lint, type check, all tests

test: test-panel test-engine test-init test-tools test-queue ## All tests

test-panel: ## Panel readers and drawing (Node 22.6 or newer)
	$(NODE_TEST) test/data_test.mjs

test-engine: ## The pane through Claude Code's own plugin test kit
	claude plugin test plugin

test-init: ## The init on scratch repos: files, idempotence, edits kept
	bash test/init_test.sh

test-tools: ## lead_status.py and run_action.sh
	bash test/tools_test.sh

test-queue: ## queue.sh: limits, stale locks, FIFO (about a minute)
	bash test/queue_test.sh

lint: ## shellcheck, Python, plugin validate, word and style scans
	bash test/lint.sh

typecheck: ## The hooks module against Claude Code's API declarations
	bash test/typecheck.sh

preview: ## Print the pane as text for the repo in REPO (default: this one)
	node --experimental-strip-types --no-warnings test/preview.mjs $(REPO)
