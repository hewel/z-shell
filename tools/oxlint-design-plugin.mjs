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
const SCALLOP_ALLOWED_FILES = new Set([
  "SessionLockOverlay.tsx",
  "QuickSettingsPanel.tsx",
  "SettingsWindow.tsx",
  "SettingsSidebar.tsx",
  "icons.tsx",
  "shapes.ts",
]);
const EXPRESSIVE_PATH_NAME_RE = /(?:scallop|rosette|shellEmblem|cookie[46]|clover4|flower5|morphShape|passwordShape)/i;
const SVG_BEZIER_PATH_RE = /^\s*M\s*-?\d[\d.,\s-]*[CcQqSsTt]/;
const ALLOWED_VECTOR_VIEWBOXES = new Set(["0 0 24 24", "0 0 64 64"]);

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

      const checkBgFgPair = (bgNode, fgNode) => {
        if (
          bgNode.type === "ConditionalExpression" &&
          fgNode.type === "ConditionalExpression" &&
          sameAstCondition(bgNode.test, fgNode.test, context.sourceCode)
        ) {
          checkPair(fgNode.consequent, resolveColorRole(bgNode.consequent, aliases), resolveColorRole(fgNode.consequent, aliases));
          checkPair(fgNode.alternate, resolveColorRole(bgNode.alternate, aliases), resolveColorRole(fgNode.alternate, aliases));
          return;
        }
        if (bgNode.type === "ConditionalExpression") {
          const fgRole = resolveColorRole(fgNode, aliases);
          if (fgRole) {
            checkPair(fgNode, resolveColorRole(bgNode.consequent, aliases), fgRole);
            checkPair(fgNode, resolveColorRole(bgNode.alternate, aliases), fgRole);
          }
          return;
        }
        if (fgNode.type === "ConditionalExpression") {
          const bgRole = resolveColorRole(bgNode, aliases);
          if (bgRole) {
            checkPair(fgNode.consequent, bgRole, resolveColorRole(fgNode.consequent, aliases));
            checkPair(fgNode.alternate, bgRole, resolveColorRole(fgNode.alternate, aliases));
          }
          return;
        }
        const bgRole = resolveColorRole(bgNode, aliases);
        const fgRole = resolveColorRole(fgNode, aliases);
        if (bgRole && fgRole) {
          checkPair(fgNode, bgRole, fgRole);
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
          checkBgFgPair(bgNode, fgNode);
        },
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier" || node.name.name !== "ShellIcon") return;
          const colorAttr = (node.attributes ?? []).find(
            attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "color",
          );
          if (!colorAttr?.value) return;
          const fgNode =
            colorAttr.value.type === "Literal"
              ? colorAttr.value
              : colorAttr.value.type === "JSXExpressionContainer"
                ? colorAttr.value.expression
                : null;
          if (!fgNode) return;

          // Walk up to the nearest enclosing JSXElement that declares a backgroundColor.
          // Stop if an enclosing container paints its own vector backdrop (e.g. scalloped rosette avatar).
          let cur = node.parent?.parent;
          let bgNode = null;
          while (cur) {
            if (cur.type === "JSXElement") {
              const hasVectorBackdrop = (cur.children ?? []).some(
                child =>
                  child.type === "JSXElement" &&
                  child.openingElement?.name?.type === "JSXIdentifier" &&
                  child.openingElement.name.name === "vector",
              );
              if (hasVectorBackdrop) break;
              const styleAttr = (cur.openingElement?.attributes ?? []).find(
                attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "style",
              );
              const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
              if (styleExpr?.type === "ObjectExpression") {
                const { map } = getStyleProps(styleExpr);
                const candidate = map.get("backgroundColor") ?? map.get("background-color") ?? map.get("background");
                if (candidate) {
                  bgNode = candidate;
                  break;
                }
              }
            }
            cur = cur.parent;
          }
          if (!bgNode) return;
          checkBgFgPair(bgNode, fgNode);
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

          // Exempt compact pill/circular FABs such as the 72x56 media play/pause button.
          const isCompactFab =
            !grows &&
            width !== null && height !== null && width <= 72 && height <= 56 &&
            (radius === "999px" || radius === "var(--radius-pill)");

          const isLargeContainer =
            isQsTile ||
            (!isCompactFab && ((height !== null && height >= 44) || (width !== null && width >= 44) || grows));

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
      docs: { description: "Enforce The Expressive-Budget Rule: restrict wavy progress to MediaPanel and scalloped rosettes to brand mark and user avatar badges" },
      schema: [],
    },
    create(context) {
      const basename = path.basename(context.filename ?? "");
      const allowWavy = WAVY_ALLOWED_FILES.has(basename);
      const allowScallop = SCALLOP_ALLOWED_FILES.has(basename);

      const reportScallop = node => {
        context.report({
          node,
          message:
            "Expressive-Budget Rule: scalloped rosettes (shellEmblem) are reserved strictly for the z-shell brand mark (Settings sidebar header) and user avatar badges (QuickSettingsPanel / SessionLockOverlay) — use Material 'apps' for functional Launcher triggers.",
        });
      };

      const checkName = (node, name) => {
        if (!allowWavy && /wavy(?:progress|slider|bar)/i.test(name)) {
          context.report({
            node,
            message: "Expressive-Budget Rule: wavy progress bars are reserved strictly for MediaPanel.tsx.",
          });
        }
        if (!allowScallop && /(?:scallop|rosette|shellEmblem)/i.test(name)) {
          reportScallop(node);
        }
      };

      const checkLiteral = (node, value) => {
        if (!allowScallop && typeof value === "string" && /^shellEmblem$/i.test(value.trim())) {
          reportScallop(node);
        }
      };

      return {
        Identifier(node) {
          checkName(node, node.name);
        },
        JSXIdentifier(node) {
          checkName(node, node.name);
        },
        Literal(node) {
          checkLiteral(node, node.value);
        },
        TemplateLiteral(node) {
          if (node.expressions.length === 0) {
            checkLiteral(node, node.quasis[0]?.value?.cooked ?? "");
          }
        },
      };
    },
  },

  "no-hand-authored-expressive-paths": {
    meta: {
      type: "problem",
      docs: { description: "Enforce The Exact-Geometry Shape Rule: disallow hand-estimated SVG Bezier literals for M3 Expressive shapes" },
      schema: [],
    },
    create(context) {
      const basename = path.basename(context.filename ?? "");
      if (basename === "shapes.ts") return {};
      const checkNamedValue = (name, valueNode) => {
        if (!name || !EXPRESSIVE_PATH_NAME_RE.test(name)) return;
        const text = staticString(valueNode);
        if (text && SVG_BEZIER_PATH_RE.test(text)) {
          context.report({
            node: valueNode,
            message:
              `Exact-Geometry Shape Rule: do not hand-author Bezier path "${name}". Generate symmetric expressive shapes analytically via apps/shell/src/shapes.ts.`,
          });
        }
      };
      return {
        VariableDeclarator(node) {
          if (node.id?.type === "Identifier" && node.init) {
            checkNamedValue(node.id.name, node.init);
          }
        },
        Property(node) {
          const key = propertyName(node);
          if (key === "d") {
            const parentProp = node.parent?.type === "ObjectExpression" ? node.parent.parent : null;
            const ownerName = parentProp?.type === "Property" ? propertyName(parentProp) : null;
            checkNamedValue(ownerName, node.value);
          } else {
            checkNamedValue(key, node.value);
          }
        },
      };
    },
  },

  "material-icon-grid": {
    meta: {
      type: "problem",
      docs: { description: "Enforce The Material-First Icon Rule: 24x24 viewBox for system UI glyphs and centralized ShellIcon usage" },
      schema: [],
    },
    create(context) {
      const filename = (context.filename ?? "").replace(/\\/g, "/");
      const basename = path.basename(filename);
      const isShellSurfaceOrPanel =
        filename.includes("/apps/shell/src/panels/") ||
        filename.includes("/apps/shell/src/surfaces/") ||
        filename.startsWith("apps/shell/src/panels/") ||
        filename.startsWith("apps/shell/src/surfaces/");

      return {
        Property(node) {
          if (basename !== "icons.tsx") return;
          if (propertyName(node) !== "viewBox") return;
          const parentProp = node.parent?.type === "ObjectExpression" ? node.parent.parent : null;
          const iconName = parentProp?.type === "Property" ? propertyName(parentProp) : null;
          const value = staticString(node.value);
          if (!value) return;
          if (iconName === "shellEmblem") {
            if (value !== "0 0 64 64" && value !== "0 0 24 24") {
              context.report({ node: node.value, message: `Expressive mark viewBox must be "0 0 64 64" or "0 0 24 24", got "${value}".` });
            }
            return;
          }
          if (value !== "0 0 24 24") {
            context.report({
              node: node.value,
              message: `Material-First Icon Rule: system UI icon "${iconName ?? "unknown"}" must use Material 24x24 grid (viewBox="0 0 24 24"), got "${value}".`,
            });
          }
        },
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier" || node.name.name !== "vector") return;
          for (const attr of node.attributes) {
            if (attr.type !== "JSXAttribute" || attr.name?.type !== "JSXIdentifier") continue;
            const attrValue =
              attr.value?.type === "Literal"
                ? (typeof attr.value.value === "string" ? attr.value.value : null)
                : attr.value?.type === "JSXExpressionContainer"
                  ? staticString(attr.value.expression)
                  : null;
            if (
              attr.name.name === "viewBox" &&
              attrValue !== null &&
              !ALLOWED_VECTOR_VIEWBOXES.has(attrValue.trim()) &&
              !(WAVY_ALLOWED_FILES.has(basename) && attrValue.trim() === "0 0 328 28")
            ) {
              context.report({
                node: attr.value,
                message: `Material-First Icon Rule: <vector> viewBox must be "0 0 24 24" (Material grid) or "0 0 64 64" (expressive shape), got "${attrValue}".`,
              });
            }
            if (isShellSurfaceOrPanel && attr.name.name === "d" && attrValue !== null) {
              context.report({
                node: attr.value,
                message:
                  "Material-First Icon Rule: do not inline ad-hoc SVG path literals in panels/surfaces; register Material Icons in icons.tsx or analytical shapes in shapes.ts.",
              });
            }
          }
        },
      };
    },
  },

  "single-owner-ia": {
    meta: {
      type: "problem",
      docs: { description: "Enforce The Single-Owner IA Rule: Notifications & DND belong to Calendar, not Control Center; telemetry cards do not belong in Calendar" },
      schema: [],
    },
    create(context) {
      const basename = path.basename(context.filename ?? "");
      if (basename !== "QuickSettingsPanel.tsx" && basename !== "CalendarPanel.tsx") return {};
      return {
        Literal(node) {
          if (typeof node.value !== "string") return;
          if (basename === "QuickSettingsPanel.tsx" && /^(?:notifications\.(?:clear|dismiss|set-dnd)|Do Not Disturb)$/.test(node.value)) {
            context.report({
              node,
              message: `Single-Owner IA Rule: "${node.value}" belongs exclusively to CalendarPanel.tsx, not QuickSettingsPanel.tsx.`,
            });
          }
        },
        Identifier(node) {
          if (basename === "QuickSettingsPanel.tsx" && node.name === "RecentNotifications") {
            context.report({
              node,
              message: "Single-Owner IA Rule: Notifications history belongs exclusively to CalendarPanel.tsx.",
            });
          }
          if (basename === "CalendarPanel.tsx" && node.name === "SystemTelemetryCards") {
            context.report({
              node,
              message: "Single-Owner IA Rule: System telemetry belongs to BatteryPanel / Settings Window, not CalendarPanel.tsx.",
            });
          }
        },
        JSXIdentifier(node) {
          if (basename === "QuickSettingsPanel.tsx" && node.name === "RecentNotifications") {
            context.report({
              node,
              message: "Single-Owner IA Rule: Notifications history belongs exclusively to CalendarPanel.tsx.",
            });
          }
          if (basename === "CalendarPanel.tsx" && node.name === "SystemTelemetryCards") {
            context.report({
              node,
              message: "Single-Owner IA Rule: System telemetry belongs to BatteryPanel / Settings Window, not CalendarPanel.tsx.",
            });
          }
        },
      };
    },
  },

  "split-action-divider": {
    meta: {
      type: "problem",
      docs: { description: "Enforce The Split-Action Guardrail: split QuickTile controls must include a vertical hairline divider before the chevron" },
      schema: [],
    },
    create(context) {
      const basename = path.basename(context.filename ?? "");
      if (basename !== "QuickSettingsPanel.tsx") return {};
      return {
        JSXElement(node) {
          const opening = node.openingElement;
          const isQsTile = opening?.attributes?.some(
            attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "data-qs-tile",
          );
          if (!isQsTile) return;
          const text = context.sourceCode?.getText?.(node) ?? "";
          if (text.includes("qs-open-") && !text.includes("data-split-divider")) {
            context.report({
              node: opening,
              message:
                "Split-Action Guardrail: QuickTile with sub-panel chevron must separate its primary toggle from the chevron with a 1px vertical hairline (mark with data-split-divider=\"true\").",
            });
          }
        },
      };
    },
  },

  "tabular-readout": {
    meta: {
      type: "problem",
      docs: { description: "Enforce The Tabular Readout Rule: live monospace numeric readout slots must specify fontVariantNumeric: 'tabular-nums'" },
      schema: [],
    },
    create(context) {
      const NUMERIC_READOUT_RE = /(?:%|\bseconds\(\)|\b(?:formatTrackTimeUs|formatDurationSeconds|formatBytesGiB|Math\.round|toFixed|percentage|charge_cycles|strength|battery|timeout_seconds)\b)/;
      const enclosingTextElement = node => {
        let cur = node.parent;
        while (cur) {
          if (cur.type === "JSXElement") {
            const name = cur.openingElement?.name;
            return name?.type === "JSXIdentifier" && name.name === "text" ? cur : null;
          }
          if (cur.type === "FunctionDeclaration" || cur.type === "ArrowFunctionExpression") return null;
          cur = cur.parent;
        }
        return null;
      };
      return {
        ObjectExpression(node) {
          const { map } = getStyleProps(node);
          const fontFamily = staticString(map.get("fontFamily") ?? map.get("font-family"));
          if (fontFamily !== "var(--font-mono)") return;
          const fvn = staticString(map.get("fontVariantNumeric") ?? map.get("font-variant-numeric"));
          if (fvn === "tabular-nums") return;

          const isTabularSlot = isEnclosingJsxElementWithAttr(node, "data-tabular");
          const textEl = enclosingTextElement(node);
          const childrenText = textEl
            ? (textEl.children ?? []).map(child => context.sourceCode?.getText?.(child) ?? "").join(" ")
            : "";
          if (isTabularSlot || (textEl && NUMERIC_READOUT_RE.test(childrenText))) {
            context.report({
              node,
              message: "Tabular Readout Rule: numeric readout slots using var(--font-mono) must declare fontVariantNumeric: \"tabular-nums\".",
            });
          }
        },
      };
    },
  },

  "bluetooth-safe-action": {
    meta: {
      type: "problem",
      docs: { description: "Enforce DESIGN.md Device List safety: do not render a destructive Remove/Forget action directly on a connected Bluetooth device row" },
      schema: [],
    },
    create(context) {
      const basename = path.basename(context.filename ?? "");
      if (basename !== "QuickSettingsSubpages.tsx") return {};
      return {
        FunctionDeclaration(node) {
          if (node.id?.name !== "BluetoothPage") return;
          const text = context.sourceCode?.getText?.(node) ?? "";
          if (/label="Remove"/.test(text) && !/Show\s+when=\{!dev\(\)\.connected\}/.test(text)) {
            context.report({
              node: node.id,
              message:
                "Device List safety rule: do not show destructive Remove/Forget action on a connected Bluetooth device; gate Remove behind !dev().connected and keep Disconnect as the primary action.",
            });
          }
        },
      };
    },
  },

  "composite-input-focus": {
    meta: {
      type: "problem",
      docs: { description: "Composite input rows (<row> containing icons/controls + <TextField>) must delegate focus ring styling to the outer rounded container via data-composite-input + shell-composite-field + onFocus/onBlur" },
      schema: [],
    },
    create(context) {
      const hasAttr = (opening, name) =>
        (opening?.attributes ?? []).some(attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === name);
      const getStringAttr = (opening, name) => {
        for (const attr of opening?.attributes ?? []) {
          if (attr.type !== "JSXAttribute" || attr.name?.type !== "JSXIdentifier" || attr.name.name !== name) continue;
          if (attr.value?.type === "Literal" && typeof attr.value.value === "string") return attr.value.value;
          if (attr.value?.type === "JSXExpressionContainer") return staticString(attr.value.expression);
        }
        return null;
      };
      return {
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier" || (node.name.name !== "TextField" && node.name.name !== "Input")) return;
          const jsxElement = node.parent;
          const parentElement = jsxElement?.parent;
          if (!parentElement || parentElement.type !== "JSXElement") return;
          const parentName = parentElement.openingElement?.name;
          if (!parentName || parentName.type !== "JSXIdentifier" || parentName.name !== "row") return;
          const elementSiblings = (parentElement.children ?? []).filter(
            child => child !== jsxElement && child.type === "JSXElement",
          );
          if (elementSiblings.length === 0) return;

          const wrapperMarked = getStringAttr(parentElement.openingElement, "data-composite-input") === "true";
          const fieldClass = getStringAttr(node, "class") ?? "";
          const hasCompositeClass = fieldClass.split(/\s+/).includes("shell-composite-field");
          const handlesFocus = hasAttr(node, "onFocus") && hasAttr(node, "onBlur");
          if (!wrapperMarked || !hasCompositeClass || !handlesFocus) {
            context.report({
              node,
              message:
                "Composite Input Focus Rule: <TextField> inside a <row> with sibling icons/controls must delegate focus to the outer rounded container (data-composite-input=\"true\" on <row>, class=\"... shell-composite-field\" + onFocus/onBlur on <TextField>).",
            });
          }
        },
      };
    },
  },

  "no-hover-hit-target-shift": {
    meta: {
      type: "problem",
      docs: { description: "Disallow geometric CSS transform directly on :hover/:active subject selectors so hover/press animations never shift pointer hit-testing and cause oscillation" },
      schema: [],
    },
    create(context) {
      const CSS_RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
      const GEOMETRIC_TRANSFORM_RE = /\btransform\s*:\s*[^;]*(?:translate|scale|rotate|skew|matrix)/i;
      const SUBJECT_INTERACTIVE_PSEUDO_RE = /:(?:hover|active)(?::[a-z-]+)*\s*$/i;

      const checkCssText = (node, cssText) => {
        if (!cssText.includes(":hover") && !cssText.includes(":active")) return;
        CSS_RULE_RE.lastIndex = 0;
        let match;
        while ((match = CSS_RULE_RE.exec(cssText)) !== null) {
          const selectorList = match[1] ?? "";
          const body = match[2] ?? "";
          if (!GEOMETRIC_TRANSFORM_RE.test(body)) continue;
          for (const rawSelector of selectorList.split(",")) {
            const selector = rawSelector.trim();
            if (!selector) continue;
            // Split on combinators; only the rightmost compound selector is the transformed subject.
            const subject = selector.split(/[\s>+~]+/).pop() ?? "";
            if (SUBJECT_INTERACTIVE_PSEUDO_RE.test(subject)) {
              context.report({
                node,
                message: `Hover Hit-Target Stability Rule: do not apply geometric transform directly on ":hover/:active" subject selector "${selector}". Keep the interactive hit target stationary and transform a pointer-events: none inner child (e.g. "parent:hover > [data-dock-visual]") to prevent hover oscillation.`,
              });
            }
          }
        }
      };

      return {
        Literal(node) {
          if (typeof node.value === "string") checkCssText(node, node.value);
        },
        TemplateLiteral(node) {
          if (node.expressions.length === 0) {
            checkCssText(node, node.quasis[0]?.value?.cooked ?? "");
          }
        },
        JSXOpeningElement(node) {
          const isVisualChild = (node.attributes ?? []).some(
            attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "data-dock-visual",
          );
          if (!isVisualChild) return;
          const styleAttr = (node.attributes ?? []).find(
            attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "style",
          );
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          if (!styleExpr || styleExpr.type !== "ObjectExpression") return;
          const { map } = getStyleProps(styleExpr);
          const pe = staticString(map.get("pointerEvents") ?? map.get("pointer-events"));
          if (pe !== "none") {
            context.report({
              node,
              message: "Hover Hit-Target Stability Rule: transformed visual child [data-dock-visual] must set pointerEvents: \"none\" so it never alters hit-testing.",
            });
          }
        },
      };
    },
  },

  "no-flush-surface-shadow": {
    meta: {
      type: "problem",
      docs: { description: "Disallow CSS boxShadow on flush PopupSurface/WindowSurface root containers where shadow bleeds into clipped square corners" },
      schema: [],
    },
    create(context) {
      const FLUSH_FILES = new Set(["ShellPanels.tsx", "PluginHost.tsx", "SettingsWindow.tsx", "BarPopups.tsx"]);
      const basename = path.basename(context.filename ?? "");
      if (!FLUSH_FILES.has(basename)) return {};
      return {
        Property(node) {
          const key = propertyName(node);
          if (key !== "boxShadow" && key !== "box-shadow") return;
          const val = staticString(node.value);
          if (val !== null && val.trim().toLowerCase() === "none") return;
          context.report({
            node,
            message:
              "Flush Surface Shadow Rule: do not apply CSS boxShadow on flush PopupSurface or WindowSurface containers (shadow leaks outside borderRadius and clips at surface bounds).",
          });
        },
      };
    },
  },

  "no-core-plugin-id-branching": {
    meta: {
      type: "problem",
      docs: { description: "Enforce ADR-0005: core shell UI must never branch on hardcoded first-party plugin IDs" },
      schema: [],
    },
    create(context) {
      const filename = (context.filename ?? "").replace(/\\/g, "/");
      const inPluginPackage = /(?:^|\/)plugins\/[^/]+\/src\//.test(filename);
      if (inPluginPackage) return {};
      const PLUGIN_ID_RE = /^(?:z-shell\/)?(?:nosleep|ai-usage|theme-bridges|niri-overview)$/;
      return {
        Literal(node) {
          if (typeof node.value !== "string") return;
          if (PLUGIN_ID_RE.test(node.value.trim())) {
            context.report({
              node,
              message: `ADR-0005 Plugin Independence: core shell must not hardcode first-party plugin ID "${node.value}". Declare metadata in plugin.toml instead.`,
            });
          }
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
