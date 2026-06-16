# Vendored OKF reference bundles

These `crypto_bitcoin/` and `ga4/` bundles are copied verbatim from
[`GoogleCloudPlatform/knowledge-catalog`](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf/bundles)
(`okf/bundles/`), licensed **Apache-2.0**.

They are used as a conformance **oracle**: `reference-bundles.test.ts`
asserts that `validatePageConformance` accepts the OKF spec author's own
bundles. If that test fails, either our reading of the spec diverged or
the upstream bundles changed — investigate before "fixing" the validator.

Do not hand-edit these files. Re-fetch from upstream to update.
