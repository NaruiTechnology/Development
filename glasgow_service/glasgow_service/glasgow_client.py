"""Deprecated compatibility imports; use :mod:`glasgow_service.sbc_client`."""
from .sbc_client import SbcAuthorityRejected, SbcClientError, SbcVacuumClient

GlasgowAuthorityRejected = SbcAuthorityRejected
GlasgowClientError = SbcClientError
GlasgowVacuumClient = SbcVacuumClient

__all__ = [
    "GlasgowAuthorityRejected",
    "GlasgowClientError",
    "GlasgowVacuumClient",
    "SbcAuthorityRejected",
    "SbcClientError",
    "SbcVacuumClient",
]
