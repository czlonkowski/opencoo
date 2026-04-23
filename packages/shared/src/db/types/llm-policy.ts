export interface LlmPolicy {
  readonly thinker?: LlmTierSpec;
  readonly worker?: LlmTierSpec;
  readonly light?: LlmTierSpec;
}

export interface LlmTierSpec {
  readonly provider: string;
  readonly model: string;
}
