"""Fernet encryption for Connected Account app passwords (ADR-0002)."""

from cryptography.fernet import Fernet


def encrypt_app_password(plaintext: str, fernet_key: str) -> bytes:
    """Encrypt a Nextcloud app password for storage."""
    return Fernet(fernet_key).encrypt(plaintext.encode("utf-8"))


def decrypt_app_password(ciphertext: bytes, fernet_key: str) -> str:
    """Decrypt a stored Nextcloud app password."""
    return Fernet(fernet_key).decrypt(ciphertext).decode("utf-8")
