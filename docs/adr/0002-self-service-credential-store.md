# Self-service onboarding with an app-side encrypted credential store

> Partly superseded 2026-10-16: identity now comes from the app's own OIDC sign-in, not the forward-auth header, since the Python backend was retired (see `~/code/docs/adr/0001-default-app-stack.md`). Self-service onboarding and the Fernet-encrypted credential store stand.

Multi-user from day 1 (Viktor, Anca, Emo): Authentik forward-auth provides identity
(X-authentik-username), but acting on a user's Nextcloud data needs their own CalDAV app
password. We chose self-service Onboarding — the user pastes a Nextcloud app password,
the server validates it with a live CalDAV request, then stores it encrypted (key from
Vault) in the app's own Postgres database (new `tasks` DB on the shared CNPG cluster) —
over an ops-managed Vault map (rejected: every new user or rotated password would need a
Vault edit by Viktor; self-service also gives a natural re-onboarding path when Nextcloud
revokes or rotates a password → 401 → "reconnect your account" banner).

Consequence: this "proxy" is not stateless — it owns a small database holding encrypted
credentials (and later push subscriptions). The encryption key never lives in the DB;
losing the DB means users re-onboard, nothing worse.
