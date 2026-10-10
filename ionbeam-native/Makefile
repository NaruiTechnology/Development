# Convenience targets (Linux/macOS). Windows: scripts/install_windows.ps1, python scripts/build.py
PY ?= python3
VENV ?= .venv
VPY := $(VENV)/bin/python

.PHONY: install install-dev test lint smoke bench build run run-emulator parity clean

install:            ## venv + deps + launcher + desktop entry
	./scripts/install_linux.sh --venv $(VENV)

install-dev:        ## same, plus pytest/pyflakes/pyinstaller, no desktop entry
	./scripts/install_linux.sh --venv $(VENV) --dev --no-desktop-entry

test:
	QT_QPA_PLATFORM=offscreen $(VPY) -m pytest -q tests
	cd ../glasgow_service && PYTHONPATH=.. QT_QPA_PLATFORM=offscreen ../ionbeam-native/$(VPY) -m pytest -q -p no:cacheprovider

lint:
	$(VPY) -m pyflakes ionbeam_native scripts tests

smoke:              ## start the real app offscreen against the emulator + mock backend for 6 s
	$(VPY) scripts/smoke.py --seconds 6

bench:
	$(VPY) scripts/benchmark_pipeline.py --frames 5 --resolution 512

build:              ## tests + distributable bundle in dist/
	$(VPY) scripts/build.py

run:
	$(VPY) -m ionbeam_native

run-emulator:
	$(VPY) -m ionbeam_native --emulator

parity:             ## regenerate tests/parity/web_cases.json from the web sources
	cd tests/parity && npm ci --no-audit --no-fund && npm run generate

clean:
	rm -rf dist build *.egg-info .pytest_cache
	find . -name __pycache__ -prune -exec rm -rf {} +
