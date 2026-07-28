DROP INDEX IF EXISTS idx_roadmap_items_difficulty;

ALTER TABLE roadmap_items DROP COLUMN difficulty;

UPDATE roadmap_items
SET document = json_remove(
  document,
  '$.difficulty',
  '$.confidence',
  '$.progress',
  '$.proposedImplementation',
  '$.affectedComponents',
  '$.dependencies',
  '$.risks',
  '$.requiredResearch',
  '$.verificationResults',
  '$.benchmarks',
  '$.relatedCommits',
  '$.relatedPullRequests',
  '$.milestone',
  '$.communityReactionCount',
  '$.duplicateReportCount'
);

UPDATE audit_history
SET before_json = json_remove(
  before_json,
  '$.difficulty',
  '$.confidence',
  '$.progress',
  '$.proposedImplementation',
  '$.affectedComponents',
  '$.dependencies',
  '$.risks',
  '$.requiredResearch',
  '$.verificationResults',
  '$.benchmarks',
  '$.relatedCommits',
  '$.relatedPullRequests',
  '$.milestone',
  '$.communityReactionCount',
  '$.duplicateReportCount'
)
WHERE before_json IS NOT NULL;

UPDATE audit_history
SET after_json = json_remove(
  after_json,
  '$.difficulty',
  '$.confidence',
  '$.progress',
  '$.proposedImplementation',
  '$.affectedComponents',
  '$.dependencies',
  '$.risks',
  '$.requiredResearch',
  '$.verificationResults',
  '$.benchmarks',
  '$.relatedCommits',
  '$.relatedPullRequests',
  '$.milestone',
  '$.communityReactionCount',
  '$.duplicateReportCount'
);

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '6');
