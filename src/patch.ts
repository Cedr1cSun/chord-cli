/** File paths touched by a Codex apply_patch payload, taken from its header lines. */
export function patchFiles(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split('\n')) {
    const m = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/.exec(line); // a heredoc may indent the headers
    if (m) out.add(m[1]);
  }
  return [...out];
}
