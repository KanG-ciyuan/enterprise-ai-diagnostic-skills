async function runDiagnostic({ projectId, stageId }) {
  const source = window.diagnosticMvpFixture;
  return {
    contractVersion: "diagnostic-agent-output.v1",
    projectId,
    runId: `${projectId}-${Date.now()}`,
    stageId,
    evidenceLevel: source.evidenceLevel,
    executionMode: "fixture",
    facts: structuredClone(source.confirmedFacts).map((fact) => ({
      ...fact,
      sourceRefs: [fact.sourceLabel],
      provenanceStatus: "supported",
    })),
    candidateInterpretations: structuredClone(source.candidateInterpretations),
    alternativeExplanations: structuredClone(source.alternativeExplanations),
    unresolvedQuestions: structuredClone(source.unresolvedQuestions),
    findings: structuredClone(source.agentFindings),
    recommendations: structuredClone(source.agentRecommendations),
    confirmationItems: structuredClone(source.confirmationItems).map((item) => ({
      ...item,
      sourceRefs: [item.sourceLabel],
    })),
    outputs: structuredClone(source.outputs),
    warnings: [],
  };
}
