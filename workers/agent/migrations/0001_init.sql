-- River agent schema. Owners are lowercase 0x addresses: the wallet that signs (Agentic Wallet or Altana account).
CREATE TABLE users (
  address TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- agentic_wallet | altana
  telegram_chat_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE mandates (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  asset TEXT NOT NULL,
  params TEXT NOT NULL,               -- MandateFile JSON (agent/src/mandate.ts)
  status TEXT NOT NULL,               -- active | paused
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner, asset)
);

CREATE TABLE agent_state (
  mandate_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,                -- AgentState JSON (agent/src/store.ts)
  updated_at INTEGER NOT NULL
);

CREATE TABLE cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  record TEXT NOT NULL                -- CycleRecord JSON
);
CREATE INDEX cycles_by_mandate ON cycles (mandate_id, closed_at);

CREATE TABLE ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL
);
CREATE INDEX ticks_by_mandate ON ticks (mandate_id, at);

-- Flow A: the baw session file, sealed with RIVER_MASTER_KEY. `salt` derives the BINANCE_INSTANCE_ID.
CREATE TABLE baw_sessions (
  owner TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  salt TEXT NOT NULL,
  expires_at INTEGER,                 -- sessionExpireTime (slides with activity)
  max_at INTEGER,                     -- signInMaxTime (hard cap)
  reminded_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  state TEXT NOT NULL,                -- pending | success | failed
  owner TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE telegram_links (
  token TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
