// Public surface for @opencoo/shared/prompts. Concrete pipelines
// (classifier today; compiler / lint in PR 16-17) consume this
// module; PR 14 webhook receiver does not — it doesn't make LLM
// calls.

export {
  loadPrompt,
  PROMPT_NAMES,
  PROMPT_LOCALES,
  type LoadPromptArgs,
  type LoadedPrompt,
  type PromptLocale,
  type PromptName,
} from "./loader.js";
