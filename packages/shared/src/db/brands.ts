declare const brand: unique symbol;

export type Branded<T, B extends string> = T & {
  readonly [brand]: B;
};

export type DomainId = Branded<string, "DomainId">;
export type SourceBindingId = Branded<string, "SourceBindingId">;
export type UserId = Branded<string, "UserId">;
export type CredentialId = Branded<string, "CredentialId">;
