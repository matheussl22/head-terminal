/** Shown in the pane header and treated as "not yet a conversation" in
 * history until the CLI transcript is identified. */
export const NEW_CONVERSATION_LABEL = "nova conversa";

export interface PaneConversationView {
  /** Name to show: user's label, transcript title, or a short id fallback.
   * Null while the pane has no CLI session to hang a name on. */
  name: string | null;
  isCustom: boolean;
  /** What the header actually paints, including the empty-state label. */
  displayName: string;
}

/** The header's name for a pane. No CLI session id means the conversation
 * has not been saved yet — that is the "nova conversa" the history list
 * must not keep showing after the user has already typed. */
export function resolvePaneConversationView(input: {
  cliSessionId?: string;
  title?: string;
  customLabel?: string;
}): PaneConversationView {
  const custom = input.customLabel;
  const fallback = input.cliSessionId
    ? `conversa ${input.cliSessionId.slice(0, 8)}`
    : null;
  const name = custom ?? (input.cliSessionId ? (input.title ?? fallback) : null);

  return {
    name,
    isCustom: Boolean(custom),
    displayName: name ?? NEW_CONVERSATION_LABEL,
  };
}
