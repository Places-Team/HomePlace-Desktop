export function shouldDismissIncomingShelf(hadIncoming: boolean, hasIncoming: boolean, busy: boolean, hasDraft: boolean, hasError: boolean) {
  return hadIncoming && !hasIncoming && !busy && !hasDraft && !hasError;
}

export function groupIncomingFiles<T extends { id: string; kind: string; sourceName: string }>(offers: T[]) {
  const groups = new Map<string, { sourceName: string; files: T[] }>();
  const seen = new Set<string>();
  for (const offer of offers) {
    if (offer.kind !== "file" || seen.has(offer.id)) continue;
    seen.add(offer.id);
    const group = groups.get(offer.sourceName) ?? { sourceName: offer.sourceName, files: [] };
    group.files.push(offer);
    groups.set(offer.sourceName, group);
  }
  return [...groups.values()];
}
export function incomingHintExpanded(visible: boolean, expanded: boolean, hasWork: boolean) {
  return hasWork || (visible && expanded);
}

export function incomingFileCount<T extends { id: string; kind: string; sourceName: string }>(
  offers: T[], batches: { status: string; files: { received: boolean }[] }[],
) {
  return groupIncomingFiles(offers).reduce((count, group) => count + group.files.length, 0)
    + batches.filter(batch => batch.status === "offered" || batch.status === "accepted")
      .reduce((count, batch) => count + batch.files.filter(file => !file.received).length, 0);
}
