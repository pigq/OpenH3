# OpenH3 Changelog

This file records OpenH3-specific changes. The project is currently in Alpha.

## Unreleased

## 3.0.7

- Recover transient gateway errors delivered inside otherwise empty model streams, with at most two retries of the same provider request. Streams that already emitted text, reasoning or tool events are never replayed automatically.
- Classify SSE provider failures with actionable retry or credential guidance instead of unknown upstream errors. Log structured failure categories at the application boundary instead of raw provider errors.
- Include the video model previews, FastH3-Omni installation guidance, coordinated ComfyUI memory cleanup, live generation progress and idle-only automatic updates from the preceding source updates.

## 3.0.2

- Model cards submit a short installation request to the application-owned planner; installation uses the active permission policy and a single saved operation instead of repeated chat confirmations.
- Discover complete local ComfyUI installations from known roots and running instances, retain verified profiles, and report missing evidence separately from incompatible hardware.
- Show conversation plans, delegated work, background commands, installation and generation in the shared Work progress / Workspace panel.
- Preserve interrupted task context for the next user message without replaying old actions. Resume existing ComfyUI operations and jobs without duplicate submission.
- Tighten GPU coordination across processes, observe memory cleanup outcomes and preserve the single OOM retry allowance across restarts.

## Earlier source updates

- Removed inherited product PRDs and empty specification placeholders from public documentation; separated user guides from contributor debugging and architecture notes.
- Removed the comment-only npm configuration and documented the active dependency patch.

- Simplified the repository root and bilingual navigation; moved community policies into `.github/`.
- Removed obsolete upstream marketing media, private planning drafts and agent discussion transcripts while preserving tests and third-party materials.
- Consolidated documentation paths, formatting and coverage configuration; retired the stale Docker entry point.

- Organized OpenH3 product, release, plan, package, and test documentation.
- Removed upstream-only AI collaboration files and stale multilingual marketing pages.
- Added local H3/ComfyUI runtime integration, media jobs, video previews, and progress reporting.
- Collapsed repeated H3 status tool calls in the conversation view and removed stale progress warnings.

## 2.2.2-alpha

- First OpenH3 Alpha source release based on the AionUi codebase.
- Added OpenH3 branding while preserving legacy runtime identifiers for upgrade compatibility.
- Added Windows x64 unsigned preview packaging and third-party license inventory.

## Release notes

See [GitHub Releases](https://github.com/pigq/OpenH3/releases) for version-specific notes and the [release guide](docs/contributing/releases.md) for the publishing process. Provider credentials, model weights, LoRAs, converted checkpoints, and workflow assets are not included in source or builds unless their release rights are documented.
