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
