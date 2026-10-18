ALTER TABLE decision_packets ADD COLUMN last_transition_key TEXT;
CREATE INDEX IF NOT EXISTS idx_decision_packet_transition_key
ON decision_packets(id, last_transition_key);
