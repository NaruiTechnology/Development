"""Vendored Glasgow API-5 compatibility package."""

# ``glasgow.cli`` expects the distribution package to expose this symbol.
# The vendored source predates the installed API-6 package and had an empty
# ``__init__``; keep the CLI self-contained without importing API-6 Glasgow.
__version__ = "0.1.dev-vendored-api5"
