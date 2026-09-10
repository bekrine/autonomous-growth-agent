import { describe, expect, it } from "vitest";
import { HuggingFaceProvider } from "../providers/huggingface-provider.js";
import { createLLMProvider } from "../factory.js";

describe("HuggingFaceProvider", () => {
  it("identifies itself as the huggingface provider", () => {
    const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
    expect(provider.name).toBe("huggingface");
  });
});

describe("createLLMProvider", () => {
  it("prefers Hugging Face over OpenAI when both keys are set", () => {
    const provider = createLLMProvider({ huggingFaceApiKey: "hf_test", openaiApiKey: "sk_test" });
    expect(provider.name).toBe("huggingface");
  });

  it("falls back to OpenAI when only an OpenAI key is set", () => {
    const provider = createLLMProvider({ openaiApiKey: "sk_test" });
    expect(provider.name).toBe("openai");
  });

  it("falls back to the mock provider when no key is set", () => {
    const provider = createLLMProvider({});
    expect(provider.name).toBe("mock");
  });
});
