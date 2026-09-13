import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WCAG 2.2 AA contrast over the tokens this app actually ships.
 *
 * DESIGN-SYSTEMS.md section 13 asks for AA text and control contrast. Checking that by eye is how a
 * 4.41 passes for a 4.5 — the difference is invisible and the rule is not. So the ratios are
 * computed from the hex values in `styles/tokens.css`, and the pairs are read out of the CSS modules
 * rather than listed by hand: a pair nobody wrote down is exactly the pair that goes unchecked.
 *
 * Run: `node scripts/check-contrast.mjs`. Exits non-zero on a failing text pair.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const tokens = parseTokens(readFileSync(join(root, "styles", "tokens.css"), "utf8"));

/*
 * Only pairs that certainly meet.
 *
 * A rule that sets both `color` and `background` puts those two tokens against each other, and no
 * inference is needed. Cross-producting every ink with every surface instead reports things like
 * "ink-soft on black-panel" — a dark ink on a dark panel it never touches — and fifteen such lines
 * are how one real finding gets skimmed past.
 *
 * The cost is honest and worth stating: a rule that sets `color` while its background comes from an
 * ancestor is not covered here, and is checked by reading the component.
 */
const pairs = [];

for (const file of stylesheets(root)) {
  const css = readFileSync(file, "utf8");

  for (const rule of css.matchAll(/\{([^{}]*)\}/g)) {
    const body = rule[1];
    const fg = body.match(/(?<![-\w])color:\s*var\(--([a-z0-9-]+)\)/);
    const bg = body.match(/background(?:-color)?:\s*var\(--([a-z0-9-]+)\)/);

    if (fg === null || bg === null || !tokens.has(fg[1]) || !tokens.has(bg[1])) {
      continue;
    }

    pairs.push({
      fg: fg[1],
      bg: bg[1],
      ratio: contrast(tokens.get(fg[1]), tokens.get(bg[1])),
      file: file.slice(root.length + 1),
    });
  }
}

const failures = pairs.filter((pair) => pair.ratio < 4.5);

console.log(`${pairs.length} rules set both a token colour and a token background.\n`);

for (const pair of [...pairs].sort((a, b) => a.ratio - b.ratio)) {
  const verdict = pair.ratio >= 4.5 ? "AA" : pair.ratio >= 3.0 ? "AA-large" : "FAIL";

  console.log(`  ${pair.ratio.toFixed(2).padStart(6)}  ${verdict.padEnd(9)} --${pair.fg} on --${pair.bg}  (${pair.file})`);
}

console.log(
  failures.length === 0
    ? "\nEvery co-located pair clears 4.5:1."
    : `\n${failures.length} pair(s) below 4.5:1.`,
);

process.exitCode = failures.length === 0 ? 0 : 1;

function parseTokens(css) {
  const map = new Map();

  for (const match of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    map.set(match[1], match[2]);
  }

  return map;
}

function stylesheets(directory) {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") {
      return [];
    }

    const path = join(directory, name);

    if (statSync(path).isDirectory()) {
      return stylesheets(path);
    }

    return name.endsWith(".css") ? [path] : [];
  });
}

function channel(value) {
  const c = value / 255;

  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const value = hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
