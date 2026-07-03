"""Persistent state: Connected Accounts (ADR-0002) + the Op idempotency journal.

The app password is Fernet-encrypted with ``TASKS_FERNET_KEY``. The key never
lives in the DB — losing the DB just means users re-onboard, nothing worse.
"""

from datetime import datetime

from sqlalchemy import DateTime, LargeBinary, String, func
from sqlalchemy.orm import Mapped, mapped_column

from tasks_api.db import Base


class ConnectedAccount(Base):
    """A household user's link between their Authentik identity and their Nextcloud account."""

    __tablename__ = "connected_accounts"

    # Authentik identity (X-Authentik-Username) — one Connected Account per user.
    authentik_username: Mapped[str] = mapped_column(String(255), primary_key=True)
    nc_username: Mapped[str] = mapped_column(String(255), nullable=False)
    enc_app_password: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AppliedOp(Base):
    """Idempotency journal: one row per Op ever applied (or deduplicated).

    A replayed batch (flaky network, app restart mid-drain) hits this table and
    returns ``duplicate`` instead of double-applying — the other half of the
    recipe is the create-UID existence check in the ops router.
    """

    __tablename__ = "applied_ops"

    authentik_username: Mapped[str] = mapped_column(String(255), primary_key=True)
    op_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    applied_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
