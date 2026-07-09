// Shared design-token substrate for pi-canvas browser surfaces.
//
// Light + dark are defined once as CSS custom properties. The viewer's explicit
// `data-theme` (stamped on <html> by the review-dock toggle) wins over the OS
// `prefers-color-scheme` in both directions. This replaces the per-renderer
// hardcoded `:root { color-scheme: light; font-family: Inter … }` blocks and the
// repeated hex literals that previously lived in each built-in renderer and the
// review dock. Style renderers through these tokens, never with raw hex.
//
// Token names are `--pc-*` prefixed so the substrate is safe to inject into
// arbitrary host pages without colliding with page-authored custom properties.

const LIGHT_TOKENS = `
    --pc-bg: #e9eef3; --pc-surface: #ffffff; --pc-surface-2: #f4f7fa;
    --pc-text: #16212d; --pc-text-muted: #536170; --pc-text-faint: #8695a2;
    --pc-border: #d5dee6; --pc-border-strong: #bcc7d3;
    --pc-accent: #0f766e; --pc-accent-weak: rgba(15, 118, 110, 0.12); --pc-accent-ring: rgba(15, 118, 110, 0.20); --pc-on-accent: #ffffff;
    --pc-ok: #16815f; --pc-warn: #b45309; --pc-info: #4f46e5;
    --pc-pill-bg: #e7edf3; --pc-pill-text: #334456;
    color-scheme: light;`;

const DARK_TOKENS = `
    --pc-bg: #0d1319; --pc-surface: #151d25; --pc-surface-2: #1a232c;
    --pc-text: #e6edf3; --pc-text-muted: #93a1ad; --pc-text-faint: #6c7c89;
    --pc-border: #28333d; --pc-border-strong: #3a4653;
    --pc-accent: #2dd4bf; --pc-accent-weak: rgba(45, 212, 191, 0.13); --pc-accent-ring: rgba(45, 212, 191, 0.28); --pc-on-accent: #06231f;
    --pc-ok: #34d399; --pc-warn: #f59e0b; --pc-info: #a5b4fc;
    --pc-pill-bg: #22303b; --pc-pill-text: #c3d0db;
    color-scheme: dark;`;

const FONT_TOKENS =
  `--pc-font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; ` +
  `--pc-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;`;

/**
 * The token substrate CSS. Emit this at the top of a renderer's `<style>` block,
 * then reference `var(--pc-*)` in the renderer's own rules. Defines light + dark,
 * the `data-theme` overrides (which beat the media query both ways), the default
 * font family, a shared focus-visible ring, and reduced-motion handling.
 */
export function designTokensCss(): string {
  return `:root { ${FONT_TOKENS}${LIGHT_TOKENS} }
    @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK_TOKENS} } }
    :root[data-theme="light"] {${LIGHT_TOKENS} }
    :root[data-theme="dark"] {${DARK_TOKENS} }
    :root { font-family: var(--pc-font-ui); }
    :focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; } }`;
}
