/** `operation_id` that `ogw clone guild` sends with `import_guild`: `clone_guild:<guild ID>:<unix ms>`. */
export function importGuildOperationId(guildId: string, nowMs: number): string {
  return `clone_guild:${guildId}:${String(nowMs)}`;
}
