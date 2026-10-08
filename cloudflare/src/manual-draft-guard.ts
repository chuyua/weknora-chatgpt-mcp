// Hosted WeKnora draft-contract verification.
// A request containing status=draft is NOT sufficient evidence of safe draft storage.
// Only the persisted, non-indexed manual Markdown record may be considered accepted.
export function requirePersistedDraft(
  record: unknown,
  knowledgeId: string,
  kbId: string,
): void {
  if (!record || typeof record !== "object") {
    throw new Error("Persisted knowledge record cannot be verified");
  }
  const saved = record as Record<string, unknown>;
  if (saved.id !== knowledgeId ||
      saved.knowledge_base_id !== kbId ||
      saved.type !== "manual") {
    throw new Error("Persisted manual record identity mismatch");
  }
  let metadata: unknown = saved.metadata;
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata); }
    catch { throw new Error("Persisted manual metadata is not valid JSON"); }
  }
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Persisted manual metadata missing");
  }
  const m = metadata as Record<string, unknown>;
  if (m.status !== "draft" || m.format !== "markdown") {
    throw new Error("Hosted cloud did not preserve an unpublished Markdown draft");
  }
  // The reference official API creates drafts with enable_status=disabled
  // and parse_status=draft. Require these additional persisted guarantees to
  // avoid reporting success when a requested draft was indexed/published.
  if (saved.enable_status !== "disabled" || saved.parse_status !== "draft") {
    throw new Error("Hosted cloud indexed or enabled content despite draft request");
  }
}
