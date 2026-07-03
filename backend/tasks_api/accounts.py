"""Connected Accounts: the credential store behind Onboarding (ADR-0002).

Storage only — the live CalDAV validation lives in
:meth:`tasks_api.caldav_engine.CalDAVEngine.validate_credentials` and is
orchestrated by the onboarding router.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tasks_api.crypto import decrypt_app_password, encrypt_app_password
from tasks_api.models import ConnectedAccount


async def get_account(session: AsyncSession, authentik_username: str) -> ConnectedAccount | None:
    result = await session.execute(
        select(ConnectedAccount).where(
            ConnectedAccount.authentik_username == authentik_username
        )
    )
    return result.scalar_one_or_none()


async def upsert_account(
    session: AsyncSession,
    authentik_username: str,
    nc_username: str,
    app_password: str,
    fernet_key: str,
) -> ConnectedAccount:
    """Create or refresh the Connected Account (re-onboarding rotates in place)."""
    ciphertext = encrypt_app_password(app_password, fernet_key)
    account = await get_account(session, authentik_username)
    if account is None:
        account = ConnectedAccount(
            authentik_username=authentik_username,
            nc_username=nc_username,
            enc_app_password=ciphertext,
        )
        session.add(account)
    else:
        account.nc_username = nc_username
        account.enc_app_password = ciphertext
    await session.commit()
    return account


def account_password(account: ConnectedAccount, fernet_key: str) -> str:
    """Decrypt the stored app password for CalDAV use."""
    return decrypt_app_password(account.enc_app_password, fernet_key)
