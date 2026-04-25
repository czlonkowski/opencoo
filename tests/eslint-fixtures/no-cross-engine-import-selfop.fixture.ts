// Negative-case fixture for opencoo/no-cross-engine-import — the
// SELF-OP→INGESTION direction (Q12). Lives outside packages/
// engine-self-operating/** so the rule's path-based detection
// would miss it; eslint.config.js passes `appliesTo: 'self-operating'`
// in the fixtures block to force the rule to treat this file as
// engine-self-operating.
//
// `pnpm lint:fixtures` MUST fail with the no-cross-engine-import
// rule ID for this file (mirroring the existing
// no-cross-engine-import.fixture.ts which covers the
// ingestion → self-operating direction).

import { foo } from "@opencoo/engine-ingestion";

export const _ = foo;
