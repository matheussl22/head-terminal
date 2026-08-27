import { describe, expect, it } from "vitest";

import {
  NEW_CONVERSATION_LABEL,
  resolvePaneConversationView,
} from "./conversation-display";

describe("resolvePaneConversationView", () => {
  it("stays on nova conversa until the pane has a CLI session id", () => {
    expect(resolvePaneConversationView({}).displayName).toBe(
      NEW_CONVERSATION_LABEL,
    );
    expect(resolvePaneConversationView({ title: "oi" }).displayName).toBe(
      NEW_CONVERSATION_LABEL,
    );
  });

  it("uses the first user message as soon as the transcript is anchored", () => {
    expect(
      resolvePaneConversationView({
        cliSessionId: "33c584af-842d-4f34-914e-103047398416",
        title: "test",
      }).displayName,
    ).toBe("test");
  });

  it("falls back to a short id after restart, before titles are re-read", () => {
    expect(
      resolvePaneConversationView({
        cliSessionId: "33c584af-842d-4f34-914e-103047398416",
      }).displayName,
    ).toBe("conversa 33c584af");
  });

  it("prefers a name the user typed over the transcript title", () => {
    expect(
      resolvePaneConversationView({
        cliSessionId: "abc-123",
        title: "primeira mensagem",
        customLabel: "Faturamento",
      }).displayName,
    ).toBe("Faturamento");
  });
});
