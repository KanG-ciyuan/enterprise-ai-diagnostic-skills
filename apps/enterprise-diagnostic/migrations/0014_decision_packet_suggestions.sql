-- V0.2 diagnosis suggestions.
--
-- One JSON column on the existing decision packet. It holds the server-owned envelope:
-- schemaVersion, draftKind, generatedBy, createdAt, contentReview and the item list.
-- Default '[]' keeps every historical packet byte-compatible: it simply has no suggestions.
ALTER TABLE decision_packets ADD COLUMN suggestions_json TEXT NOT NULL DEFAULT '[]';
