ALTER TABLE work_items ADD COLUMN revision_reason TEXT;
ALTER TABLE work_items ADD COLUMN revision_from_version INTEGER;
ALTER TABLE work_items ADD COLUMN revision_packet_id TEXT;
ALTER TABLE decision_packets ADD COLUMN revision_reason TEXT;
ALTER TABLE decision_packets ADD COLUMN revision_from_version INTEGER;
ALTER TABLE decision_packets ADD COLUMN revision_work_item_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_task_packet
ON work_items(revision_packet_id)
WHERE revision_packet_id IS NOT NULL;
