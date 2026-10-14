# Whop user OAuth for OMNIWORLD

This replaces the unsupported company/user access-token minting path. The bridge
uses confidential OAuth with PKCE and no company_id. It verifies the userinfo sub
against WHOP_PUBLISHER_USER_ID (default: the confirmed urfavceo75 account).

Required Railway configuration:

- WHOP_CLIENT_SECRET: existing protected client secret.
- WHOP_CLIENT_ID: optional override of app_gGGQXuk3OaYUkP.
- WHOP_OAUTH_ENCRYPTION_KEY: new random secret of at least 32 characters, stored
  in Railway variables. Keep it stable across deployments.
- Dedicated persistent volume mounted at /data/whop-oauth.
- WHOP_OAUTH_DATA_DIR=/data/whop-oauth. The Railway volume mount path must match.
- SYNC_ENABLED=false until actual forum posting and subsequent sync behavior
  have been verified separately.

Redirect URI: https://telegram-whop-bridge-production.up.railway.app/oauth/whop/callback

Requested scopes: openid, profile, forum:read, forum:post:create. The operator
initiates consent from the authenticated setup page. Only the callback bypasses
the administrator session gate; it requires an unexpired one-use state and
browser-bound secure HttpOnly SameSite=Lax cookie. No token is returned to the UI.

Access and refresh tokens are encrypted with AES-256-GCM on the volume, saved
atomically with fsync. The encryption key remains in Railway variables. Refresh
is serialized and the rotated token is saved before reuse. On refresh failure,
publishing fails closed and requires reconnection. One service replica only.

The operator approved encrypted persistent Railway storage on 2026-10-15.
Plaintext credentials must never be committed or returned in API responses.

Validation: node --test whop-oauth.test.js oauth-integration.test.js
Tests use mocked Whop responses; they do not establish that Whop authorizes a
real post in this admin-only forum. After consent, use the authenticated test
button for a controlled post with read-back verification. Do not enable sync
just because OAuth consent succeeded.
