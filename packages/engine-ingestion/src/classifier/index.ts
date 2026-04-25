// Public surface for the Classifier subsystem (architecture §6.6,
// THREAT-MODEL §3.4). The Scanner pipeline (PR 16+) consumes
// `classify` + the typed errors for DLQ routing; tests import
// individual guards / spotlight directly.

export {
  classify,
  type ClassifyArgs,
} from "./classifier.js";
export {
  ClassifierValidationError,
} from "./errors.js";
export {
  spotlight,
  type SpotlightArgs,
} from "./spotlight.js";
export {
  assertBindingNotWildcardOnly,
  BindingConfigError,
} from "./binding-guard.js";
export {
  validateAllowedPath,
  ClassifierPathError,
} from "./path-guard.js";
export {
  CLASSIFIER_OUTPUT_SCHEMA,
  TARGET_DOMAIN_SCHEMA,
  type ClassifierOutput,
  type ClassifierOutputWire,
  type ClassifierTargetDomain,
} from "./types.js";
