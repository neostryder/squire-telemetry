-- One row per batch. Decision and full batches keep their decision records in the blobs table under blob_key.
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  level TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  mod_version TEXT NOT NULL,
  game_version TEXT NOT NULL,
  summary TEXT NOT NULL,
  blob_key TEXT,
  bytes INTEGER NOT NULL,
  UNIQUE (install_id, run_id, seq)
);
CREATE INDEX IF NOT EXISTS batches_install ON batches (install_id);
CREATE INDEX IF NOT EXISTS batches_received ON batches (received_at);

-- Decision records and full run logs live here, one row per batch, so the batches table stays small enough to scan per install.
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS blobs_install ON blobs (install_id);
CREATE INDEX IF NOT EXISTS blobs_received ON blobs (received_at);

-- Finished runs already posted to Discord, so a run is posted once.
CREATE TABLE IF NOT EXISTS posted (
  install_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  PRIMARY KEY (install_id, run_id)
);
