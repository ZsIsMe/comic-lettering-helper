.PHONY: frontend backend-test verify-local

frontend:
	npm --prefix frontend run build

backend-test:
	.venv/bin/pytest -q backend/tests

verify-local:
	.venv/bin/python deploy/verify.py --app-root "$(CURDIR)" --comfy-root "$${COMFY_ROOT:-/root/ComfyUI}"
