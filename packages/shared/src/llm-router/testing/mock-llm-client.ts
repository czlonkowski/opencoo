import { LlmProviderError } from "../errors.js";
import type {
  LlmProvider,
  LlmProviderCall,
  LlmProviderResponse,
} from "../interface.js";

export interface MockLlmMatch {
  readonly model: string;
  readonly promptIncludes: string;
}

export interface MockLlmRegistration {
  readonly match: MockLlmMatch;
  readonly response: LlmProviderResponse;
}

// Table-driven mock for the LlmProvider interface. Tests register
// `{match: {model, promptIncludes}, response: {text, tokensIn, tokensOut}}`
// entries; any unmatched `generate` call throws `LlmProviderError` so
// silent fallbacks can't hide a miswired test.
//
// Intentionally NO recording mode — recording against real providers
// is a v0.2 concern (see architecture §14.3). Tests pass fixtures
// explicitly.
export class MockLlmClient implements LlmProvider {
  private readonly registrations: MockLlmRegistration[] = [];

  register(reg: MockLlmRegistration): void {
    this.registrations.push(reg);
  }

  async generate(call: LlmProviderCall): Promise<LlmProviderResponse> {
    const hit = this.registrations.find(
      (r) =>
        r.match.model === call.model &&
        call.prompt.includes(r.match.promptIncludes),
    );
    if (hit === undefined) {
      throw new LlmProviderError(
        `MockLlmClient: no registration matched (model=${call.model}, prompt snippet=${call.prompt.slice(0, 80)})`,
      );
    }
    return hit.response;
  }
}
