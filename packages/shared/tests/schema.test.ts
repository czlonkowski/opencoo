import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  credentials,
  domains,
  domainClass,
  governanceCadence,
  reviewMode,
  sourcesBindings,
  userRole,
  users,
} from "../src/db/schema/index.js";

interface ColumnLike {
  readonly name: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly default: unknown;
  readonly getSQLType: () => string;
}

function columnByName(
  config: ReturnType<typeof getTableConfig>,
  name: string,
): ColumnLike {
  const col = config.columns.find((c) => c.name === name);
  if (col === undefined) {
    throw new Error(
      `column '${name}' not found on table '${config.name}' (found: ${config.columns
        .map((c) => c.name)
        .join(", ")})`,
    );
  }
  return col as unknown as ColumnLike;
}

describe("pg enums", () => {
  it("domain_class has three values: knowledge, catalog-workflows, catalog-skills", () => {
    expect(domainClass.enumName).toBe("domain_class");
    expect([...domainClass.enumValues]).toEqual([
      "knowledge",
      "catalog-workflows",
      "catalog-skills",
    ]);
  });

  it("governance_cadence has five values", () => {
    expect(governanceCadence.enumName).toBe("governance_cadence");
    expect([...governanceCadence.enumValues]).toEqual([
      "continuous",
      "nightly",
      "weekly",
      "quarterly",
      "adhoc",
    ]);
  });

  it("review_mode has three values", () => {
    expect(reviewMode.enumName).toBe("review_mode");
    expect([...reviewMode.enumValues]).toEqual(["auto", "approve", "review"]);
  });

  it("user_role has two values", () => {
    expect(userRole.enumName).toBe("user_role");
    expect([...userRole.enumValues]).toEqual(["admin", "operator"]);
  });
});

describe("domains table", () => {
  const config = getTableConfig(domains);

  it("is named 'domains'", () => {
    expect(config.name).toBe("domains");
  });

  it("has uuid PK 'id' with gen_random_uuid() default", () => {
    const id = columnByName(config, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
    const pks = config.primaryKeys;
    const allPks = [
      ...pks.flatMap((pk) => pk.columns.map((c) => c.name)),
      ...config.columns.filter((c) => c.primary).map((c) => c.name),
    ];
    expect(allPks).toContain("id");
  });

  it("has slug text NOT NULL UNIQUE", () => {
    const slug = columnByName(config, "slug");
    expect(slug.getSQLType()).toBe("text");
    expect(slug.notNull).toBe(true);
    const uniqueNames = config.uniqueConstraints.flatMap((u) =>
      u.columns.map((c) => c.name),
    );
    expect(uniqueNames).toContain("slug");
  });

  it("has name text NOT NULL", () => {
    const name = columnByName(config, "name");
    expect(name.getSQLType()).toBe("text");
    expect(name.notNull).toBe(true);
  });

  it("has class domain_class NOT NULL DEFAULT 'knowledge'", () => {
    const col = columnByName(config, "class");
    expect(col.getSQLType()).toBe("domain_class");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("knowledge");
  });

  it("has locale text NOT NULL DEFAULT 'en' with IN check", () => {
    const col = columnByName(config, "locale");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("en");
    expect(config.checks.length).toBeGreaterThan(0);
  });

  it("has governance_cadence enum NOT NULL DEFAULT 'continuous'", () => {
    const col = columnByName(config, "governance_cadence");
    expect(col.getSQLType()).toBe("governance_cadence");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("continuous");
  });

  it("has nullable review_role text", () => {
    const col = columnByName(config, "review_role");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has llm_policy jsonb NOT NULL DEFAULT '{}'", () => {
    const col = columnByName(config, "llm_policy");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has nullable llm_budget_monthly_cap_usd numeric(10,2)", () => {
    const col = columnByName(config, "llm_budget_monthly_cap_usd");
    expect(col.getSQLType()).toBe("numeric(10, 2)");
    expect(col.notNull).toBe(false);
  });

  it("has nullable retention_days integer", () => {
    const col = columnByName(config, "retention_days");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(false);
  });

  it("has worldview_enabled boolean NOT NULL DEFAULT true", () => {
    const col = columnByName(config, "worldview_enabled");
    expect(col.getSQLType()).toBe("boolean");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(true);
  });

  it("has created_at + updated_at timestamptz NOT NULL DEFAULT now()", () => {
    const created = columnByName(config, "created_at");
    const updated = columnByName(config, "updated_at");
    expect(created.getSQLType()).toBe("timestamp with time zone");
    expect(created.notNull).toBe(true);
    expect(created.hasDefault).toBe(true);
    expect(updated.getSQLType()).toBe("timestamp with time zone");
    expect(updated.notNull).toBe(true);
    expect(updated.hasDefault).toBe(true);
  });
});

describe("credentials table", () => {
  const config = getTableConfig(credentials);

  it("is named 'credentials'", () => {
    expect(config.name).toBe("credentials");
  });

  it("has id uuid PK with gen_random_uuid() default", () => {
    const id = columnByName(config, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
  });

  it("has name text NOT NULL", () => {
    const col = columnByName(config, "name");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has schema_ref text NOT NULL", () => {
    const col = columnByName(config, "schema_ref");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has ciphertext bytea NOT NULL", () => {
    const col = columnByName(config, "ciphertext");
    expect(col.getSQLType()).toBe("bytea");
    expect(col.notNull).toBe(true);
  });

  it("has iv bytea NOT NULL", () => {
    const col = columnByName(config, "iv");
    expect(col.getSQLType()).toBe("bytea");
    expect(col.notNull).toBe(true);
  });

  it("has aad bytea NOT NULL", () => {
    const col = columnByName(config, "aad");
    expect(col.getSQLType()).toBe("bytea");
    expect(col.notNull).toBe(true);
  });

  it("has encryption_version integer NOT NULL DEFAULT 1", () => {
    const col = columnByName(config, "encryption_version");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(1);
  });

  it("has created_at timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(config, "created_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has nullable rotated_at timestamptz", () => {
    const col = columnByName(config, "rotated_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });
});

describe("users table", () => {
  const config = getTableConfig(users);

  it("is named 'users'", () => {
    expect(config.name).toBe("users");
  });

  it("has id uuid PK with gen_random_uuid() default", () => {
    const id = columnByName(config, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
  });

  it("has gitea_username text UNIQUE NOT NULL", () => {
    const col = columnByName(config, "gitea_username");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
    const uniqueNames = config.uniqueConstraints.flatMap((u) =>
      u.columns.map((c) => c.name),
    );
    expect(uniqueNames).toContain("gitea_username");
  });

  it("has role user_role NOT NULL DEFAULT 'operator'", () => {
    const col = columnByName(config, "role");
    expect(col.getSQLType()).toBe("user_role");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("operator");
  });

  it("has created_at timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(config, "created_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });
});

describe("sources_bindings table", () => {
  const config = getTableConfig(sourcesBindings);

  it("is named 'sources_bindings'", () => {
    expect(config.name).toBe("sources_bindings");
  });

  it("has id uuid PK with gen_random_uuid() default", () => {
    const id = columnByName(config, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
  });

  it("has domain_id uuid NOT NULL with FK to domains(id) ON DELETE RESTRICT", () => {
    const col = columnByName(config, "domain_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);

    const fkToDomains = config.foreignKeys.find((fk) => {
      const refs = fk.reference();
      return refs.foreignTable === domains;
    });
    expect(fkToDomains).toBeDefined();
    expect(fkToDomains?.onDelete).toBe("restrict");
  });

  it("has adapter_slug text NOT NULL", () => {
    const col = columnByName(config, "adapter_slug");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has nullable source_id text", () => {
    const col = columnByName(config, "source_id");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has config jsonb NOT NULL DEFAULT '{}'", () => {
    const col = columnByName(config, "config");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has allowed_paths text[] NOT NULL DEFAULT '{}'", () => {
    const col = columnByName(config, "allowed_paths");
    expect(col.getSQLType()).toBe("text[]");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has review_mode NOT NULL DEFAULT 'auto'", () => {
    const col = columnByName(config, "review_mode");
    expect(col.getSQLType()).toBe("review_mode");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("auto");
  });

  it("has nullable schedule_cron text", () => {
    const col = columnByName(config, "schedule_cron");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has nullable credentials_id uuid with FK to credentials(id) ON DELETE RESTRICT", () => {
    const col = columnByName(config, "credentials_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);

    const fkToCredentials = config.foreignKeys.find((fk) => {
      const refs = fk.reference();
      return refs.foreignTable === credentials;
    });
    expect(fkToCredentials).toBeDefined();
    expect(fkToCredentials?.onDelete).toBe("restrict");
  });

  it("has nullable retention_days_override integer", () => {
    const col = columnByName(config, "retention_days_override");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(false);
  });

  it("has enabled boolean NOT NULL DEFAULT true", () => {
    const col = columnByName(config, "enabled");
    expect(col.getSQLType()).toBe("boolean");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(true);
  });

  it("has nullable last_scanned_at timestamptz", () => {
    const col = columnByName(config, "last_scanned_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });

  it("has nullable notes text", () => {
    const col = columnByName(config, "notes");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has created_at + updated_at timestamptz NOT NULL DEFAULT now()", () => {
    const created = columnByName(config, "created_at");
    const updated = columnByName(config, "updated_at");
    expect(created.notNull).toBe(true);
    expect(created.hasDefault).toBe(true);
    expect(updated.notNull).toBe(true);
    expect(updated.hasDefault).toBe(true);
  });

  it("has an index over (domain_id, adapter_slug)", () => {
    const idxCols = config.indexes.map((i) =>
      (i.config.columns as ReadonlyArray<{ name: string }>).map((c) => c.name),
    );
    const match = idxCols.find(
      (cols) =>
        cols.length === 2 &&
        cols[0] === "domain_id" &&
        cols[1] === "adapter_slug",
    );
    expect(match).toBeDefined();
  });
});
