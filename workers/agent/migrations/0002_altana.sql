-- Flow B: Altana smart accounts. The account is controlled by the user's passkey; River holds a session key the
-- passkey granted (1, 3 or 6 months). A renewal writes a pending key and promotes it once the grant is seen on-chain.
CREATE TABLE altana_accounts (
  owner TEXT PRIMARY KEY,             -- the smart account, lowercase
  credential_id TEXT NOT NULL,        -- passkey credential id, base64url
  passkey_pubkey TEXT NOT NULL,       -- P-256 x ‖ y, hex (not secret)
  rp_id TEXT NOT NULL,                -- WebAuthn relying party the passkey belongs to
  state TEXT NOT NULL,                -- draft | ready | revoked
  sealed_key TEXT,                    -- current session private key, sealed with RIVER_MASTER_KEY; NULL once revoked
  session_address TEXT,
  serialized TEXT,                    -- SerializedSession JSON (no key material)
  expiry INTEGER,                     -- current session expiry, unix seconds (read from the account on-chain)
  grant_tx TEXT,
  pending_sealed TEXT,                -- a key made for a grant that is not seen on-chain yet
  pending_address TEXT,
  pending_pubkey TEXT,
  reminded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX altana_by_credential ON altana_accounts (credential_id);

CREATE TABLE altana_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,            -- base64url, single use, 5 minutes
  created_at INTEGER NOT NULL
);
