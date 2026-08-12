# Release automation ownership

The Roadmap Worker does not generate GitHub release notes, edit GitHub
Releases, or publish Discord release announcements.

The SakuraCord application repository owns the complete release-publication
path. A maintainer or local agent prepares the repository's versioned release
copy before tagging. Its GitHub Actions release workflow then:

1. publishes the prepared text as the GitHub Release description; and
2. sends the prepared Discord announcement through the bot.

The Roadmap Worker still authenticates GitHub webhook deliveries sent to its
legacy endpoint, but it acknowledges every `release` event without storing or
processing it. This behavior does not depend on a marker in the release body.

Legacy unfinished `release_jobs` are terminally retired by the scheduled
Worker, the authenticated release-processing endpoint, the release-status
endpoint, and AI-account reconnect recovery. They cannot generate copy, patch
GitHub, or post to Discord after credentials are restored.

The old release configuration, status command, database table, and authenticated
processing endpoint remain temporarily for upgrade compatibility. The status
and processing paths only retire legacy work; they do not publish anything.

ChatGPT/Codex-plan OAuth remains in use for automatic Discord report analysis.
It is not used for release-note or release-announcement generation.
