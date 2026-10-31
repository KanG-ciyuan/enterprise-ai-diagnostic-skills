// Historical callers model a client view captured BEFORE invoking the handler.
// Explicit versions (including malformed/stale values) override these defaults.
// R1 missing-version tests deliberately do not use this compatibility fixture.
export function withFixtureViewedVersions(db, body) {
  if (!body?.factId || ['correct_evidence_level','upgrade_impact'].includes(body.action)) return body;
  const row = db.get('SELECT evidence_version,flow_card_version FROM candidate_facts WHERE id=?',body.factId);
  return row ? {evidenceVersion:row.evidence_version,flowCardVersion:row.flow_card_version,...body} : body;
}
