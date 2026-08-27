import { describe, expect, it } from "vitest";

import { TITLE_MAX_LENGTH, summarizeTitle } from "./session-title";

describe("summarizeTitle", () => {
  it("keeps a short prompt as it is, minus the closing period", () => {
    expect(summarizeTitle("quais os docker tenho rodando agora?")).toBe(
      "quais os docker tenho rodando agora?",
    );
    expect(summarizeTitle("desinstala o evernote dessa maquina.")).toBe(
      "desinstala o evernote dessa maquina",
    );
  });

  it("cuts the prompt at its first sentence", () => {
    expect(
      summarizeTitle(
        "Atualiza o modelo YOLO. Ele está errando as bordas do holerite e precisa de um retreino.",
      ),
    ).toBe("Atualiza o modelo YOLO");
  });

  it("pulls in the next sentence when the first one names nothing", () => {
    expect(summarizeTitle("Beleza. Remove o badge de status do header.")).toBe(
      "Remove o badge de status do header",
    );
  });

  it("keeps words that are only filler when a pause follows them", () => {
    expect(summarizeTitle("olha esse arquivo de config pra mim")).toBe(
      "olha esse arquivo de config pra mim",
    );
  });

  it("drops greetings, hedging and please-do-X wrappers", () => {
    expect(summarizeTitle("me ajuda a adicionar esse modelo na grade")).toBe(
      "adicionar esse modelo na grade",
    );
    expect(
      summarizeTitle("Tá, eu preciso fazer um levantamento dos endpoints"),
    ).toBe("fazer um levantamento dos endpoints");
    expect(summarizeTitle("consegue baixar esse video?")).toBe(
      "baixar esse video?",
    );
    expect(summarizeTitle("can you please review the pty bridge")).toBe(
      "review the pty bridge",
    );
  });

  it("keeps the subject when the prompt has nothing but filler", () => {
    expect(summarizeTitle("oi")).toBe("oi");
    expect(summarizeTitle("preciso de ajuda")).toBe("preciso de ajuda");
  });

  it("compacts urls and deep paths down to what identifies them", () => {
    expect(
      summarizeTitle("https://kraftcode.atlassian.net/browse/HOLD-1324 revisa"),
    ).toBe("kraftcode.atlassian.net/…/HOLD-1324 revisa");
    expect(
      summarizeTitle("/home/matheus/Documentos/readme.md está desatualizado"),
    ).toBe("…/readme.md está desatualizado");
  });

  it("does not mistake a version number or a domain for a sentence end", () => {
    expect(summarizeTitle("Qwen3.8-27B-Uncensored-NVFP4 roda aqui?")).toBe(
      "Qwen3.8-27B-Uncensored-NVFP4 roda aqui?",
    );
  });

  it("truncates a long single sentence on a word boundary", () => {
    const title = summarizeTitle(
      "revisa o fluxo de assinatura do holerite digital considerando os anexos enviados pelo RH",
    );
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/u);
  });
});
