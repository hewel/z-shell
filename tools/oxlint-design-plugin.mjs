import path from "node:path";

const VALID_COLOR_ROLES = new Set([
  "surface",
  "surface-dim",
  "surface-bright",
  "surface-container-lowest",
  "surface-container-low",
  "surface-container",
  "surface-container-high",
  "surface-container-highest",
  "on-surface",
  "on-surface-variant",
  "inverse-surface",
  "inverse-on-surface",
  "outline",
  "outline-variant",
  "scrim",
  "primary",
  "on-primary",
  "primary-container",
  "on-primary-container",
  "secondary",
  "on-secondary",
  "secondary-container",
  "on-secondary-container",
  "tertiary",
  "on-tertiary",
  "tertiary-container",
  "on-tertiary-container",
  "error",
  "on-error",
  "error-container",
  "on-error-container",
]);

const SURFACE_FOREGROUND_ROLES = new Set([
  "on-surface",
  "on-surface-variant",
  "primary",
  "secondary",
  "tertiary",
  "error",
  "outline",
]);

const ROLE_PAIRS = new Map([
  ["primary", new Set(["on-primary"])],
  ["primary-container", new Set(["on-primary-container"])],
  ["secondary", new Set(["on-secondary"])],
  ["secondary-container", new Set(["on-secondary-container"])],
  ["tertiary", new Set(["on-tertiary"])],
  ["tertiary-container", new Set(["on-tertiary-container"])],
  ["error", new Set(["on-error"])],
  ["error-container", new Set(["on-error-container"])],
  ["inverse-surface", new Set(["inverse-on-surface"])],
  ["surface", SURFACE_FOREGROUND_ROLES],
  ["surface-dim", SURFACE_FOREGROUND_ROLES],
  ["surface-bright", SURFACE_FOREGROUND_ROLES],
  ["surface-container-lowest", SURFACE_FOREGROUND_ROLES],
  ["surface-container-low", SURFACE_FOREGROUND_ROLES],
  ["surface-container", SURFACE_FOREGROUND_ROLES],
  ["surface-container-high", SURFACE_FOREGROUND_ROLES],
  ["surface-container-highest", SURFACE_FOREGROUND_ROLES],
]);

// DESIGN.md rounded tokens (6/8/10/14/16/22/999px) plus micro track/dot radii (1-4px) and 0/50%.
const ALLOWED_RADIUS_PX = new Set([0, 1, 2, 3, 4, 6, 8, 10, 14, 16, 22, 999]);

const RAW_COLOR_TOKEN_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgba?|hsla?)\s*\([^)]*\)/gi;
const SHADOW_BLACK_RGBA_RE = /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.\d+\s*\)$/i;
const COLOR_VAR_RE = /var\(\s*--color-([a-z0-9-]+)\s*(?:,[^)]*)?\)/g;
const MOBILE_COPY_RE = /\b(?:tap\s+to|long[- ]press)\b/i;
const SUPPRESSION_RE = /\b(?:oxlint|eslint)-disable(?:-next-line|-line)?\b/;
const FONT_TOKEN_RE = /^(?:var\(--font-(?:sans|mono)\)|inherit)$/;
const OUTLINE_NONE_RE = /^(?:none|0(?:px)?)$/i;
const WAVY_ALLOWED_FILES = new Set(["MediaPanel.tsx"]);
const SCALLOP_ALLOWED_FILES = new Set(["SessionLockOverlay.tsx", "LauncherOverlay.tsx", "icons.tsx"]);

function propertyName(prop) {
  if (!prop || prop.type !== "Property") return null;
  if (!prop.computed && prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal" && typeof prop.key.value === "string") return prop.key.value;
  return null;
}

function staticString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? null;
  }
  return null;
}

function collectStringAliases(program) {
  const aliases = new Map();
  for (const stmt of program.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (!decl || decl.type !== "VariableDeclaration" || decl.kind !== "const") continue;
    for (const item of decl.declarations) {
      if (item.id?.type !== "Identifier") continue;
      const value = staticString(item.init);
      if (value !== null) aliases.set(item.id.name, value);
    }
  }
  return aliases;
}

function resolveStaticText(node, aliases) {
  if (!node) return null;
  return staticString(node) ?? (node.type === "Identifier" ? aliases.get(node.name) ?? null : null);
}

function resolveColorRole(node, aliases) {
  const text = resolveStaticText(node, aliases);
  if (!text) return null;
  const trimmed = text.trim();
  COLOR_VAR_RE.lastIndex = 0;
  const match = COLOR_VAR_RE.exec(trimmed);
  return match && match[0] === trimmed ? match[1] : null;
}

function parsePx(node, aliases) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  const direct = resolveStaticText(node, aliases);
  if (!direct) return null;
  const match = /^(\d+(?:\.\d+)?)px$/i.exec(direct.trim());
  return match ? Number(match[1]) : null;
}

function isInShadowProperty(node) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "Property") {
      const key = propertyName(cur);
      return key === "boxShadow" || key === "box-shadow" || key === "textShadow" || key === "text-shadow";
    }
    if (cur.type === "ObjectExpression" || cur.type === "JSXElement") return false;
    cur = cur.parent;
  }
  return false;
}

function hasDisallowedRawColor(text, allowShadowBlack) {
  const matches = text.match(RAW_COLOR_TOKEN_RE);
  if (!matches) return false;
  if (!allowShadowBlack) return true;
  return matches.some(token => !SHADOW_BLACK_RGBA_RE.test(token.trim()));
}

function checkRadiusValue(value) {
  const trimmed = value.trim();
  if (trimmed === "0" || trimmed === "0px" || trimmed === "50%" || /^var\(--radius-[a-z0-9-]+\)$/.test(trimmed)) {
    return true;
  }
  const parts = trimmed.split(/\s+/);
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)px$/i.exec(part);
    if (!match) return false;
    if (!ALLOWED_RADIUS_PX.has(Number(match[1]))) return false;
  }
  return parts.length > 0;
}

function visitValueBranches(node, cb) {
  if (!node) return;
  if (node.type === "ConditionalExpression") {
    visitValueBranches(node.consequent, cb);
    visitValueBranches(node.alternate, cb);
    return;
  }
  cb(node);
}

function sameAstCondition(a, b, sourceCode) {
  if (!a || !b || !sourceCode?.getText) return false;
  return sourceCode.getText(a) === sourceCode.getText(b);
}

function getStyleProps(obj) {
  const map = new Map();
  let spreadsGrow = false;
  for (const prop of obj.properties) {
    if (prop.type === "SpreadElement") {
      if (prop.argument?.type === "Identifier" && prop.argument.name === "grow") {
        spreadsGrow = true;
      }
      continue;
    }
    const key = propertyName(prop);
    if (key) map.set(key, prop.value);
  }
  return { map, spreadsGrow };
}

function isEnclosingJsxElementWithAttr(node, attrName) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "JSXOpeningElement") {
      return cur.attributes.some(
        attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === attrName,
      );
    }
    if (cur.type === "FunctionDeclaration" || cur.type === "ArrowFunctionExpression" || cur.type === "FunctionExpression") {
      return false;
    }
    cur = cur.parent;
  }
  return false;
}

const rules = {
  "no-raw-colors": {
    meta: {
      type: "problem",
      docs: { description: "Disallow hardcoded hex/rgb/rgba/hsl color literals in UI files (DESIGN.md Strict Role-Pairing Rule)" },
      schema: [],
    },
    create(context) {
      const checkText = (node, text) => {
        if (!text) return;
        const allowShadowBlack = isInShadowProperty(node);
        if (hasDisallowedRawColor(text, allowShadowBlack)) {
          context.report({
            node,
            message:
              "Do not hardcode raw colors (#hex/rgb/rgba/hsl) in UI code; use semantic var(--color-*) tokens or color-mix(in srgb, var(--color-...) XX%, transparent).",
          });
        }
      };
      return {
        Literal(node) {
          if (typeof node.value === "string") checkText(node, node.value);
        },
        TemplateLiteral(node) {
          const joined = node.quasis.map(q => q.value.raw).join("");
          checkText(node, joined);
        },
      };
    },
  },

  "valid-color-roles": {
    meta: {
      type: "problem",
      docs: { description: "Enforce valid 31-role Material 3 color variables and strict foreground/container pairing" },
      schema: [],
    },
    create(context) {
      let aliases = new Map();
      const checkStringForUnknownRoles = (node, text) => {
        if (!text || !text.includes("--color-")) return;
        COLOR_VAR_RE.lastIndex = 0;
        let match;
        while ((match = COLOR_VAR_RE.exec(text)) !== null) {
          const role = match[1];
          if (!VALID_COLOR_ROLES.has(role)) {
            context.report({
              node,
              message: `Unknown Material 3 color role "--color-${role}". Use one of the 31 roles from DESIGN.md / z-shell-theme.`,
            });
          }
        }
      };

      const checkPair = (node, bgRole, fgRole) => {
        if (!bgRole || !fgRole) return;
        const allowed = ROLE_PAIRS.get(bgRole);
        if (allowed && !allowed.has(fgRole)) {
          context.report({
            node,
            message: `Invalid color role pair: foreground "--color-${fgRole}" on background "--color-${bgRole}". Expected one of: ${[...allowed].map(r => `--color-${r}`).join(", ")}.`,
          });
        }
      };

      return {
        Program(program) {
          aliases = collectStringAliases(program);
        },
        Literal(node) {
          if (typeof node.value === "string") checkStringForUnknownRoles(node, node.value);
        },
        TemplateLiteral(node) {
          if (node.expressions.length === 0) {
            checkStringForUnknownRoles(node, node.quasis[0]?.value?.cooked ?? "");
          }
        },
        ObjectExpression(node) {
          const { map } = getStyleProps(node);
          const bgNode = map.get("backgroundColor") ?? map.get("background-color") ?? map.get("background");
          const fgNode = map.get("color");
          if (!bgNode || !fgNode) return;

          if (
            bgNode.type === "ConditionalExpression" &&
            fgNode.type === "ConditionalExpression" &&
            sameAstCondition(bgNode.test, fgNode.test, context.sourceCode)
          ) {
            checkPair(fgNode.consequent, resolveColorRole(bgNode.consequent, aliases), resolveColorRole(fgNode.consequent, aliases));
            checkPair(fgNode.alternate, resolveColorRole(bgNode.alternate, aliases), resolveColorRole(fgNode.alternate, aliases));
            return;
          }

          const bgRole = resolveColorRole(bgNode, aliases);
          const fgRole = resolveColorRole(fgNode, aliases);
          if (bgRole && fgRole) {
            checkPair(fgNode, bgRole, fgRole);
          }
        },
      };
    },
  },

  "calm-active-surface": {
    meta: {
      type: "problem",
      docs: { description: "Enforce The Calm Active Surface Rule: disallow high-saturation primary fill on large active containers" },
      schema: [],
    },
    create(context) {
      let aliases = new Map();
      return {
        Program(program) {
          aliases = collectStringAliases(program);
        },
        ObjectExpression(node) {
          const { map, spreadsGrow } = getStyleProps(node);
          const bgNode = map.get("backgroundColor") ?? map.get("background-color") ?? map.get("background");
          if (!bgNode) return;

          let usesPrimary = false;
          visitValueBranches(bgNode, branch => {
            if (resolveColorRole(branch, aliases) === "primary") usesPrimary = true;
          });
          if (!usesPrimary) return;

          if (isEnclosingJsxElementWithAttr(node, "data-percent-fill")) return;

          const isQsTile = isEnclosingJsxElementWithAttr(node, "data-qs-tile");
          const height = parsePx(map.get("height") ?? map.get("minHeight") ?? map.get("min-height"), aliases);
          const width = parsePx(map.get("width") ?? map.get("minWidth") ?? map.get("min-width"), aliases);
          const flexGrow = map.get("flexGrow") ?? map.get("flex-grow");
          const grows = spreadsGrow || (flexGrow?.type === "Literal" && Number(flexGrow.value) > 0);
          const radius = staticString(map.get("borderRadius") ?? map.get("border-radius"));

          // Exempt compact circular FABs such as the 52x52 media play/pause button.
          const isCompactCircleFab =
            width !== null && height !== null && width === height && width <= 56 &&
            (radius === "999px" || radius === "var(--radius-pill)");

          const isLargeContainer =
            isQsTile ||
            (!isCompactCircleFab && ((height !== null && height >= 44) || (width !== null && width >= 44) || grows));

          if (isLargeContainer) {
            context.report({
              node: bgNode,
              message:
                "Calm Active Surface Rule: do not fill large active containers with solid var(--color-primary); use var(--color-primary-container) + var(--color-on-primary-container).",
            });
          }
        },
      };
    },
  },

  "no-system-ui-font": {
    meta: {
      type: "problem",
      docs: { description: "Disallow hardcoded system-ui fontFamily; use var(--font-sans) or var(--font-mono)" },
      schema: [],
    },
    create(context) {
      return {
        Property(node) {
          const key = propertyName(node);
          if (key !== "fontFamily" && key !== "font-family") return;
          visitValueBranches(node.value, branch => {
            const val = staticString(branch);
            if (val !== null && !FONT_TOKEN_RE.test(val.trim())) {
              context.report({
                node: branch,
                message: `Do not hardcode fontFamily "${val}". Use var(--font-sans), var(--font-mono), or inherit from :root.`,
              });
            }
          });
        },
      };
    },
  },

  "valid-radius-scale": {
    meta: {
      type: "problem",
      docs: { description: "Enforce DESIGN.md desktop shape scale (6/8/10/14/16/22/999px or --radius-* tokens)" },
      schema: [],
    },
    create(context) {
      return {
        Property(node) {
          const key = propertyName(node);
          if (key !== "borderRadius" && key !== "border-radius") return;
          visitValueBranches(node.value, branch => {
            const val = staticString(branch);
            if (val !== null && !checkRadiusValue(val)) {
              context.report({
                node: branch,
                message: `Off-scale borderRadius "${val}". Use DESIGN.md shape tokens: 6px (xs), 8px (sm), 10px (md), 14px (tile), 16px (card), 22px (panel), 999px (pill), or var(--radius-*).`,
              });
            }
          });
        },
      };
    },
  },

  "no-mobile-copy": {
    meta: {
      type: "problem",
      docs: { description: "Disallow mobile interaction phrasing ('Tap to', 'Long press') in desktop shell UI" },
      schema: [],
    },
    create(context) {
      const check = (node, text) => {
        if (text && MOBILE_COPY_RE.test(text)) {
          context.report({
            node,
            message: `Use desktop interaction copy ("Click" / "Right-click") instead of mobile phrasing in "${text.trim()}".`,
          });
        }
      };
      return {
        JSXText(node) {
          check(node, node.value);
        },
        JSXAttribute(node) {
          if (node.name?.type !== "JSXIdentifier") return;
          if (!["ariaLabel", "placeholder", "title", "label", "detail"].includes(node.name.name)) return;
          if (node.value?.type === "Literal" && typeof node.value.value === "string") {
            check(node.value, node.value.value);
          } else if (node.value?.type === "JSXExpressionContainer") {
            check(node.value.expression, staticString(node.value.expression));
          }
        },
      };
    },
  },

  "no-outline-none": {
    meta: {
      type: "problem",
      docs: { description: "Disallow stripping keyboard focus outlines without an accessible replacement (WCAG 2.2 SC 2.4.7)" },
      schema: [],
    },
    create(context) {
      return {
        Property(node) {
          const key = propertyName(node);
          if (key !== "outline" && key !== "outlineWidth" && key !== "outline-width") return;
          visitValueBranches(node.value, branch => {
            const val = staticString(branch);
            if ((val !== null && OUTLINE_NONE_RE.test(val.trim())) || (branch.type === "Literal" && branch.value === 0)) {
              context.report({
                node: branch,
                message: "Do not strip focus rings with outline: none/0 (WCAG 2.2 SC 2.4.7 / 2.4.13).",
              });
            }
          });
        },
      };
    },
  },

  "expressive-budget": {
    meta: {
      type: "problem",
      docs: { description: "Enforce The Expressive-Budget Rule: restrict wavy progress to MediaPanel and scalloped shapes to brand/Launcher/SessionLock" },
      schema: [],
    },
    create(context) {
      const basename = path.basename(context.filename ?? "");
      const allowWavy = WAVY_ALLOWED_FILES.has(basename);
      const allowScallop = SCALLOP_ALLOWED_FILES.has(basename);

      const checkName = (node, name) => {
        if (!allowWavy && /wavy(?:progress|slider|bar)/i.test(name)) {
          context.report({
            node,
            message: "Expressive-Budget Rule: wavy progress bars are reserved strictly for MediaPanel.tsx.",
          });
        }
        if (!allowScallop && /scallop/i.test(name)) {
          context.report({
            node,
            message: "Expressive-Budget Rule: scalloped marks are reserved strictly for brand/Launcher and SessionLockOverlay.tsx.",
          });
        }
      };

      return {
        Identifier(node) {
          checkName(node, node.name);
        },
        JSXIdentifier(node) {
          checkName(node, node.name);
        },
      };
    },
  },

  "no-lint-suppression": {
    meta: {
      type: "problem",
      docs: { description: "Disallow inline oxlint/eslint disable directives" },
      schema: [],
    },
    create(context) {
      return {
        Program() {
          for (const comment of context.sourceCode?.getAllComments?.() ?? []) {
            if (SUPPRESSION_RE.test(comment.value)) {
              context.report({
                loc: comment.loc,
                message:
                  "Do not suppress lint rules with inline disable comments; fix the design violation or scope exclusions explicitly in .oxlintrc.json.",
              });
            }
          }
        },
      };
    },
  },
};

export default {
  meta: { name: "zshell" },
  rules,
};
