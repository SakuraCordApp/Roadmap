CREATE TABLE IF NOT EXISTS roadmap_versions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
  state TEXT NOT NULL CHECK(state IN ('draft','planned','released','cancelled')),
  position INTEGER NOT NULL CHECK(position >= 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  document TEXT NOT NULL CHECK(json_valid(document)),
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  mutation_id TEXT NOT NULL,
  mutation_action TEXT NOT NULL CHECK(mutation_action IN ('create','update','transition')),
  override_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_roadmap_versions_public_order
  ON roadmap_versions(state, position, version);

CREATE TABLE IF NOT EXISTS roadmap_version_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK(action IN ('create','update','transition')),
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  override_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(version_id) REFERENCES roadmap_versions(id) ON DELETE CASCADE,
  UNIQUE(version_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_roadmap_version_history_version_revision
  ON roadmap_version_history(version_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_roadmap_version_history_created
  ON roadmap_version_history(created_at DESC);

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '8');
