import type { JobHandler, JobKind } from "./queue";
import { deliverFeed } from "../github/feed";
import { publishRoadmap } from "../roadmap";
import {
  handleRelease,
  reconcile,
  shipIssue,
  syncMilestones,
  syncPull,
  syncPush,
} from "../sync/activity";
import { syncDiscordThread, syncGithubComment } from "../sync/comments";
import { embedIssue, syncIssue } from "../sync/issue";
import { applyTriageResult, runTriage } from "../sync/triage";

export const handlers: Record<JobKind, JobHandler> = {
  "sync-issue": syncIssue,
  triage: runTriage,
  "triage-result": applyTriageResult,
  embed: embedIssue,
  comment: syncGithubComment,
  "discord-thread": syncDiscordThread,
  pull: syncPull,
  push: syncPush,
  release: handleRelease,
  ship: shipIssue,
  milestones: (env) => syncMilestones(env),
  roadmap: publishRoadmap,
  feed: deliverFeed,
  reconcile,
};
