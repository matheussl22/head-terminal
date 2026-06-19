export function decodePtyData(data: string | Uint8Array): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}
