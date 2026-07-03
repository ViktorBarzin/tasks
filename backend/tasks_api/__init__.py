"""tasks backend — JSON delta-sync proxy between the PWA and Nextcloud CalDAV.

The client never speaks CalDAV (ADR-0001): this service alone drives sync-tokens,
ETags and ICS against Nextcloud, and owns the Connected Account store (ADR-0002).
"""

__version__ = "0.1.0"
