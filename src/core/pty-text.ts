const textDecoder = new TextDecoder();

export function decodePtyData(data: string | Uint8Array): string {
  return typeof data === "string" ? data : textDecoder.decode(data);
}
