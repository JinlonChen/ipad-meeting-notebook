const contracts = await import("@meeting/contracts");

for (const exportName of [
  "MeetingSchema",
  "FolderSchema",
  "LoginInputSchema",
  "SessionUserSchema",
]) {
  if (!contracts[exportName]) {
    throw new Error(`@meeting/contracts is missing ${exportName}`);
  }
}
