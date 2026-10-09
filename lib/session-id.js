'use strict';

// A session id becomes a file name, so only these characters are accepted. That
// rules out path separators and "." or "..". mod/hooks/register.ts keeps a copy,
// because the mod cannot require lib/. test/session-id.test.js checks the copies match.
const ID = '[A-Za-z0-9_-]{1,128}';

const SESSION_ID_PATTERN = new RegExp(`^${ID}$`);

// A snapshot or activity file, or its tmp file (`<id>.json.<pid>`, see
// writeFileAtomic in lib/files.js). prune deletes only names that match.
const SESSION_FILE_PATTERN = new RegExp(`^${ID}\\.json(\\.\\d+)?$`);

// A review file of the versions before transcripts.db. The import reads only these.
const REVIEW_FILE_PATTERN = new RegExp(`^${ID}\\.json$`);

// Snapshot and activity files older than this are deleted.
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

module.exports = { SESSION_ID_PATTERN, SESSION_FILE_PATTERN, REVIEW_FILE_PATTERN, PRUNE_AFTER_MS };
