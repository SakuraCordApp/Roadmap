UPDATE roadmap_versions
SET document = json_remove(
  document,
  '$.highlights[0].description',
  '$.highlights[1].description',
  '$.highlights[2].description',
  '$.highlights[3].description',
  '$.highlights[4].description',
  '$.highlights[5].description',
  '$.highlights[6].description',
  '$.highlights[7].description',
  '$.highlights[8].description',
  '$.highlights[9].description',
  '$.highlights[10].description',
  '$.highlights[11].description'
);

UPDATE roadmap_version_history
SET before_json = json_remove(
  before_json,
  '$.highlights[0].description',
  '$.highlights[1].description',
  '$.highlights[2].description',
  '$.highlights[3].description',
  '$.highlights[4].description',
  '$.highlights[5].description',
  '$.highlights[6].description',
  '$.highlights[7].description',
  '$.highlights[8].description',
  '$.highlights[9].description',
  '$.highlights[10].description',
  '$.highlights[11].description'
)
WHERE before_json IS NOT NULL;

UPDATE roadmap_version_history
SET after_json = json_remove(
  after_json,
  '$.highlights[0].description',
  '$.highlights[1].description',
  '$.highlights[2].description',
  '$.highlights[3].description',
  '$.highlights[4].description',
  '$.highlights[5].description',
  '$.highlights[6].description',
  '$.highlights[7].description',
  '$.highlights[8].description',
  '$.highlights[9].description',
  '$.highlights[10].description',
  '$.highlights[11].description'
);

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '10');
