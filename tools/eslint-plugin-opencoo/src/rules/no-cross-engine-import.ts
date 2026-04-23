import { createRule } from "../utils/create-rule.js";

type AppliesTo = "ingestion" | "self-operating" | "auto";

export interface NoCrossEngineImportOptions {
  appliesTo?: AppliesTo;
}

type MessageIds = "crossEngineImport";

export const noCrossEngineImport = createRule<
  [NoCrossEngineImportOptions],
  MessageIds
>({
  name: "no-cross-engine-import",
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid imports across the ingestion and self-operating engine boundary (architecture.md §2.5; THREAT-MODEL.md §2 invariant 10).",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          appliesTo: {
            type: "string",
            enum: ["ingestion", "self-operating", "auto"],
          },
        },
      },
    ],
    messages: {
      crossEngineImport:
        "Engine {{current}} must not import from engine {{peer}} — cross-engine sharing goes through packages/shared/*.",
    },
  },
  defaultOptions: [{ appliesTo: "auto" }],
  create: () => ({}),
});
