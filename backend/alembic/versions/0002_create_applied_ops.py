"""create applied_ops (op idempotency journal)

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-03

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "applied_ops",
        sa.Column("authentik_username", sa.String(length=255), primary_key=True),
        sa.Column("op_id", sa.String(length=255), primary_key=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column(
            "applied_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("applied_ops")
