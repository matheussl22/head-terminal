import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";

import { IpcError } from "./errors";

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;

export function assertTrustedSender(event: IpcEvent, trusted: WebContents): void {
  if (event.sender.id !== trusted.id || event.senderFrame !== trusted.mainFrame) {
    throw new IpcError("UNTRUSTED_SENDER", "IPC request came from an untrusted frame");
  }
}

export function asString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  if (typeof value !== "string") {
    throw new IpcError("INVALID_INPUT", `${field} must be a string`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new IpcError("INVALID_INPUT", `${field} must not be empty`);
  }
  if (value.length > (options.maxLength ?? 1_000_000)) {
    throw new IpcError("INVALID_INPUT", `${field} is too long`);
  }
  return value;
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new IpcError("INVALID_INPUT", `${field} must be a boolean`);
  }
  return value;
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IpcError("INVALID_INPUT", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
