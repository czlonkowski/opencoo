/**
 * React 19 moved JSX into the `react` namespace; this ambient
 * declaration re-exports it as the global `JSX` namespace so
 * existing `: JSX.Element` return types in the project keep
 * compiling without the React 19 import-source migration.
 *
 * Once the codebase moves to React 19's recommended return-
 * type syntax (`(): React.ReactNode`), this file can go away.
 */
import type { JSX as ReactJsx } from "react";

declare global {
  namespace JSX {
    type Element = ReactJsx.Element;
    type ElementType = ReactJsx.ElementType;
    type ElementClass = ReactJsx.ElementClass;
    type IntrinsicElements = ReactJsx.IntrinsicElements;
  }
}
