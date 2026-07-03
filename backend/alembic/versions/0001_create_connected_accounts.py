"""create connected_accounts

Revision ID: 0001
Revises:
Create Date: 2026-07-03

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "connected_accounts",
        sa.Column("authentik_username", sa.String(length=255), primary_key=True),
        sa.Column("nc_username", sa.String(length=255), nullable=False),
        sa.Column("enc_app_password", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("connected_accounts")
