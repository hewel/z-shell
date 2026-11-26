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

// DESIGN.md rounded tokens (6/8/10/12/14/16/22/999px) plus micro track/dot radii (1-4px) and 0/50%.
const ALLOWED_RADIUS_PX = new Set([0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 22, 999]);

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
const TELEMETRY_CHART_FILES = new Set(["TelemetryCharts.tsx"]);
const TELEMETRY_CHART_VIEWBOXES = new Set([
  "0 0 36 16",
  "0 0 30 30",
  "0 0 340 72",
  "0 0 380 88",
  "0 0 536 88",
  "0 0 536 112",
  "0 0 250 64",
  "0 0 536 64",
  "0 0 536 96",
]);

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
  if (trimmed === "0" || trimmed === "0px" || trimmed === "50%" || trimmed === "inherit" || /^var\(--radius-[a-z0-9-]+\)$/.test(trimmed)) {
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

function getAttr(opening, name) {
  return (opening?.attributes ?? []).find(
    attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === name,
  );
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
                message: `Off-scale borderRadius "${val}". Use DESIGN.md shape tokens: 6px (xs), 8px (sm), 10px (md), 12px (concentric dock/pill), 14px (tile), 16px (card), 22px (panel), 999px (pill), or var(--radius-*).`,
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
              !(WAVY_ALLOWED_FILES.has(basename) && attrValue.trim() === "0 0 328 28") &&
              !(TELEMETRY_CHART_FILES.has(basename) && TELEMETRY_CHART_VIEWBOXES.has(attrValue.trim()))
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
          const attrs = node.attributes ?? [];
          const findAttr = name =>
            attrs.find(attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === name);
          const styleAttr = findAttr("style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          const styleMap = styleExpr?.type === "ObjectExpression" ? getStyleProps(styleExpr).map : null;

          if (findAttr("data-dock-visual") && styleMap) {
            const pe = staticString(styleMap.get("pointerEvents") ?? styleMap.get("pointer-events"));
            if (pe !== "none") {
              context.report({
                node,
                message: "Hover Hit-Target Stability Rule: transformed visual child [data-dock-visual] must set pointerEvents: \"none\" so it never alters hit-testing.",
              });
            }
          }

          if (findAttr("data-press-visual") && styleMap) {
            const peNode = styleMap.get("pointerEvents") ?? styleMap.get("pointer-events");
            const pe = staticString(peNode);
            if (peNode && pe !== "none") {
              context.report({
                node,
                message: "Hover Hit-Target Stability Rule: [data-press-visual] must preserve pointerEvents: \"none\" so press compression never shifts hit-testing.",
              });
            }
          }

          if (node.name?.type === "JSXIdentifier" && node.name.name === "Button" && styleMap) {
            const disabledAttr = findAttr("disabled");
            const staticallyDisabled =
              disabledAttr &&
              (disabledAttr.value === null ||
                (disabledAttr.value?.type === "JSXExpressionContainer" &&
                  disabledAttr.value.expression?.type === "Literal" &&
                  disabledAttr.value.expression.value === true));
            if (!staticallyDisabled) {
              const cursor = staticString(styleMap.get("cursor"));
              if (cursor === "default" || cursor === "auto") {
                context.report({
                  node,
                  message: `Universal Pointer Affordance Rule: do not override cursor to "${cursor}" on an enabled <Button>; interactive controls must preserve cursor: pointer.`,
                });
              }
            }
          }
        },
      };
    },
  },

  "no-flush-surface-shadow": {
    meta: {
      type: "problem",
      docs: { description: "Disallow CSS boxShadow on flush WindowSurface (prefer-no-csd) or PopupSurface containers lacking geometryInsets bleed" },
      schema: [],
    },
    create(context) {
      const FLUSH_FILES = new Set(["ShellPanels.tsx", "PluginHost.tsx", "SettingsWindow.tsx", "SystemMonitorWindow.tsx", "BarPopups.tsx"]);
      const basename = path.basename(context.filename ?? "");
      if (!FLUSH_FILES.has(basename)) return {};
      const isToplevelWindow = basename === "SettingsWindow.tsx" || basename === "SystemMonitorWindow.tsx";
      let hasGeometryInsets = false;
      const shadowNodes = [];
      return {
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier" || node.name.name !== "PopupSurface") return;
          if (
            (node.attributes ?? []).some(
              attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "geometryInsets",
            )
          ) {
            hasGeometryInsets = true;
          }
        },
        Property(node) {
          const key = propertyName(node);
          if (key !== "boxShadow" && key !== "box-shadow") return;
          const val = staticString(node.value);
          if (val !== null && val.trim().toLowerCase() === "none") return;
          shadowNodes.push(node);
        },
        "Program:exit"() {
          if (!isToplevelWindow && hasGeometryInsets) return;
          for (const node of shadowNodes) {
            context.report({
              node,
              message: isToplevelWindow
                ? "Flush Surface Shadow Rule: do not apply CSS boxShadow on WindowSurface (xdg_toplevel prefers compositor-owned shadows)."
                : "Flush Surface Shadow Rule: do not apply CSS boxShadow on flush PopupSurface containers without geometryInsets bleed (shadow leaks outside borderRadius and clips at surface bounds).",
            });
          }
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
      const PLUGIN_ID_RE = /^(?:z-shell\/)?(?:ai-usage|theme-bridges|niri-overview)$/;
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

  "m3-motion-tokens": {
    meta: {
      type: "problem",
      docs: { description: "Enforce M3 Motion tokens: ban ad-hoc spring literals outside motion.ts, non-M3 CSS timing curves, and outline-width transitions" },
      schema: [],
    },
    create(context) {
      const filename = (context.filename ?? "").replace(/\\/g, "/");
      const isMotionCore =
        filename.endsWith("/packages/sdk/src/motion.ts") ||
        filename.endsWith("packages/sdk/src/motion.ts") ||
        filename.endsWith("/apps/shell/src/motion.ts") ||
        filename.endsWith("apps/shell/src/motion.ts");

      const ALLOWED_M3_BEZIERS = new Set([
        "0.05,0.7,0.1,1",
        "0.3,0,0.8,0.15",
        "0.2,0,0,1",
        "0,0,0,1",
        "0.3,0,1,1",
      ]);

      const normalizeBezier = raw =>
        raw
          .split(",")
          .map(part => String(Number(part.trim())))
          .join(",");

      const checkTimingValue = (node, value) => {
        const trimmed = value.trim();
        if (!trimmed || trimmed === "linear" || /^var\(--motion-easing-[a-z0-9-]+\)$/.test(trimmed)) return;
        const bezierMatch = /^cubic-bezier\(([^)]+)\)$/i.exec(trimmed);
        if (bezierMatch && ALLOWED_M3_BEZIERS.has(normalizeBezier(bezierMatch[1]))) return;
        context.report({
          node,
          message: `M3 Motion Rule: disallow non-M3 timing function "${trimmed}". Use var(--motion-easing-*) or official M3 cubic-bezier / linear tokens.`,
        });
      };

      const checkCssString = (node, text) => {
        if (!text.includes("transition")) return;
        const timingRe = /transition-timing-function\s*:\s*([^;}\n]+)/gi;
        let match;
        while ((match = timingRe.exec(text)) !== null) {
          checkTimingValue(node, match[1]);
        }
        const outlineWidthRe = /transition(?:-property)?\s*:[^;}\n]*\boutline-width\b/i;
        if (outlineWidthRe.test(text)) {
          context.report({
            node,
            message: "M3 Motion Rule: never animate outline-width (docs/design/motion.md §5.8); fade focus ring color/opacity instead.",
          });
        }
      };

      return {
        ObjectExpression(node) {
          if (isMotionCore) return;
          const { map } = getStyleProps(node);
          if (map.has("stiffness") && (map.has("damping") || map.has("dampingRatio"))) {
            context.report({
              node,
              message: "M3 Motion Rule: do not inline ad-hoc { stiffness, damping } spring configs; use M3 spring roles from motion.ts / @z-shell/sdk/zgui.",
            });
          }
        },
        Property(node) {
          const key = propertyName(node);
          if (key === "transitionTimingFunction" || key === "transition-timing-function") {
            const val = staticString(node.value);
            if (val !== null) checkTimingValue(node.value, val);
          } else if (key === "transitionProperty" || key === "transition-property" || key === "transition") {
            const val = staticString(node.value);
            if (val !== null && /\boutline-width\b/i.test(val)) {
              context.report({
                node: node.value,
                message: "M3 Motion Rule: never animate outline-width (docs/design/motion.md §5.8); fade focus ring color/opacity instead.",
              });
            }
          }
        },
        Literal(node) {
          if (typeof node.value === "string") checkCssString(node, node.value);
        },
        TemplateLiteral(node) {
          if (node.expressions.length === 0) {
            checkCssString(node, node.quasis[0]?.value?.cooked ?? "");
          }
        },
      };
    },
  },

  "no-direct-raf-loop": {
    meta: {
      type: "problem",
      docs: { description: "Enforce single shared frame scheduler: ban direct requestAnimationFrame calls outside packages/sdk/src/motion.ts" },
      schema: [],
    },
    create(context) {
      const filename = (context.filename ?? "").replace(/\\/g, "/");
      if (filename.endsWith("/packages/sdk/src/motion.ts") || filename.endsWith("packages/sdk/src/motion.ts")) {
        return {};
      }
      return {
        CallExpression(node) {
          const callee = node.callee;
          const isRaf =
            (callee?.type === "Identifier" && callee.name === "requestAnimationFrame") ||
            (callee?.type === "MemberExpression" &&
              !callee.computed &&
              callee.property?.type === "Identifier" &&
              callee.property.name === "requestAnimationFrame");
          if (isRaf) {
            context.report({
              node,
              message: "Single Frame Scheduler Rule: do not call requestAnimationFrame directly; use createM3Spring / createPhaseLoop / registerFrameTicker from @z-shell/sdk/zgui.",
            });
          }
        },
      };
    },
  },

  "solid-show-keyed-callback": {
    meta: {
      type: "problem",
      docs: { description: "Require a parameter on <Show keyed> render callbacks so Solid 2 rebuilds children when the key changes between truthy values" },
      schema: [],
    },
    create(context) {
      return {
        JSXElement(node) {
          const opening = node.openingElement;
          if (opening?.name?.type !== "JSXIdentifier" || opening.name.name !== "Show") return;
          const isKeyed = (opening.attributes ?? []).some(
            attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "keyed",
          );
          if (!isKeyed) return;
          for (const child of node.children ?? []) {
            if (child.type !== "JSXExpressionContainer") continue;
            const expr = child.expression;
            if (
              (expr?.type === "ArrowFunctionExpression" || expr?.type === "FunctionExpression") &&
              (expr.params?.length ?? 0) === 0
            ) {
              context.report({
                node: expr,
                message:
                  "Solid 2 <Show keyed> Rule: keyed render callbacks must accept at least one parameter (e.g. `_key => ...`). Zero-arg callbacks have `fn.length === 0` and do not remount when the key changes between truthy values.",
              });
            }
          }
        },
      };
    },
  },

  "min-hit-target-size": {
    meta: {
      type: "problem",
      docs: { description: "Enforce WCAG 2.2 SC 2.5.8 minimum 24x24px interactive hit target size on static Button/control styles" },
      schema: [],
    },
    create(context) {
      const PX_RE = /^(\d+(?:\.\d+)?)px$/;
      const checkDim = (propNode, propName, rawVal) => {
        if (typeof rawVal !== "string") return;
        const match = PX_RE.exec(rawVal.trim());
        if (!match) return;
        const px = Number(match[1]);
        if (px > 0 && px < 24) {
          context.report({
            node: propNode,
            message: `WCAG 2.2 SC 2.5.8 Hit-Target Rule: interactive control declares ${propName}: "${rawVal}" (< 24px). Keep interactive hit targets >= 24x24px.`,
          });
        }
      };
      const inspectStyleExpr = expr => {
        if (!expr) return;
        if (expr.type === "ObjectExpression") {
          for (const prop of expr.properties) {
            if (prop.type !== "Property") continue;
            const key = propertyName(prop);
            if (key !== "width" && key !== "height" && key !== "minWidth" && key !== "minHeight") continue;
            if (prop.value?.type === "ConditionalExpression") {
              checkDim(prop.value.consequent, key, staticString(prop.value.consequent));
              checkDim(prop.value.alternate, key, staticString(prop.value.alternate));
            } else {
              checkDim(prop.value, key, staticString(prop.value));
            }
          }
        } else if (expr.type === "ConditionalExpression") {
          inspectStyleExpr(expr.consequent);
          inspectStyleExpr(expr.alternate);
        }
      };
      return {
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier" || (node.name.name !== "Button" && node.name.name !== "control")) return;
          for (const attr of node.attributes ?? []) {
            if (attr.type !== "JSXAttribute" || attr.name?.type !== "JSXIdentifier" || attr.name.name !== "style") continue;
            if (attr.value?.type === "JSXExpressionContainer") {
              inspectStyleExpr(attr.value.expression);
            }
          }
        },
      };
    },
  },

  "no-pill-action-button": {
    meta: {
      type: "problem",
      docs: { description: "Enforce desktop button radius (10px md / 8px sm): disallow 999px pill radius on rectangular text action Buttons" },
      schema: [],
    },
    create(context) {
      const basename = path.basename(context.filename ?? "");
      if (basename === "StatusBar.tsx" || basename === "widget.tsx") return {};
      let aliases = new Map();
      const hasAttr = (opening, name) =>
        (opening?.attributes ?? []).some(
          attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === name,
        );
      const hasTextContent = jsxEl => {
        for (const child of jsxEl.children ?? []) {
          if (child.type === "JSXText" && child.value.trim().length > 0) return true;
          if (child.type === "JSXElement") {
            const name = child.openingElement?.name;
            if (name?.type === "JSXIdentifier" && name.name === "text") return true;
          }
        }
        return false;
      };
      return {
        Program(program) {
          aliases = collectStringAliases(program);
        },
        JSXElement(node) {
          const opening = node.openingElement;
          if (opening?.name?.type !== "JSXIdentifier" || opening.name.name !== "Button") return;
          if (hasAttr(opening, "data-switch-root") || hasAttr(opening, "data-bar-pill")) return;
          if (!hasTextContent(node)) return;
          const styleAttr = (opening.attributes ?? []).find(
            attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "style",
          );
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          if (!styleExpr || styleExpr.type !== "ObjectExpression") return;
          const { map } = getStyleProps(styleExpr);
          const radiusNode = map.get("borderRadius") ?? map.get("border-radius");
          if (!radiusNode) return;
          const width = parsePx(map.get("width"), aliases);
          const height = parsePx(map.get("height"), aliases);
          // Square circular icon/swatch/avatar badges (e.g. 24x24, 36x36) are allowed.
          if (width !== null && height !== null && width === height) return;
          visitValueBranches(radiusNode, branch => {
            const val = resolveStaticText(branch, aliases)?.trim();
            if (val === "999px" || val === "var(--radius-pill)") {
              context.report({
                node: branch,
                message:
                  "Desktop Action Button Rule: do not use pill borderRadius (999px) on rectangular text action buttons; use M3Button (10px md / 8px sm) or M3FilterChip (8px).",
              });
            }
          });
        },
      };
    },
  },

  "semantic-elevation-tokens": {
    meta: {
      type: "problem",
      docs: { description: "Require semantic var(--shadow-level-1/2/3) tokens for boxShadow instead of hardcoded dark-only rgba() shadows" },
      schema: [],
    },
    create(context) {
      return {
        Property(node) {
          const key = propertyName(node);
          if (key !== "boxShadow" && key !== "box-shadow") return;
          visitValueBranches(node.value, branch => {
            const val = staticString(branch);
            if (!val) return;
            const trimmed = val.trim();
            if (trimmed === "none" || /^var\(--shadow-level-[123]\)$/.test(trimmed)) return;
            if (RAW_COLOR_TOKEN_RE.test(trimmed)) {
              RAW_COLOR_TOKEN_RE.lastIndex = 0;
              context.report({
                node: branch,
                message:
                  "Semantic Elevation Rule: do not hardcode rgba()/hex boxShadow values (breaks Light Mode); use var(--shadow-level-1), var(--shadow-level-2), or var(--shadow-level-3).",
              });
            }
          });
        },
      };
    },
  },

  "no-unblurred-translucent-surface": {
    meta: {
      type: "problem",
      docs: { description: "Enforce 4-Tier Frosted Glass vs. Solid Material Ladder & Wayland Graceful Solid Fallback: disallow unblurred translucent surfaces across all glass tiers and disallow backdropFilter on always-solid Settings surfaces" },
      schema: [],
    },
    create(context) {
      const filename = (context.filename ?? "").replace(/\\/g, "/");
      const basename = path.basename(filename);
      if (basename === "SessionLockOverlay.tsx") return {};
      const isAlwaysSolidSurface =
        basename === "SettingsWindow.tsx" ||
        basename === "SettingsSidebar.tsx" ||
        basename === "SystemMonitorWindow.tsx" ||
        filename.includes("/apps/shell/src/surfaces/settings/") ||
        filename.startsWith("apps/shell/src/surfaces/settings/");
      const TRANSLUCENT_SURFACE_RE = /color-mix\(\s*in\s+srgb\s*,\s*var\(--color-(?:surface(?:-container(?:-(?:lowest|low|high|highest))?|-dim|-bright)?|primary-container)\)\s+(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)/i;
      return {
        ObjectExpression(node) {
          const { map } = getStyleProps(node);
          const blurNode = map.get("backdropFilter") ?? map.get("backdrop-filter");
          if (isAlwaysSolidSurface && blurNode) {
            const blurVal = staticString(blurNode)?.trim().toLowerCase();
            if (blurVal !== "none") {
              context.report({
                node: blurNode,
                message:
                  "4-Tier Material Ladder Rule: Settings Window (Level 3) must remain 100% solid opaque M3 without backdropFilter.",
              });
            }
          }
          const bgNode = map.get("backgroundColor") ?? map.get("background-color") ?? map.get("background");
          if (!bgNode) return;
          if (blurNode && !isAlwaysSolidSurface) return;
          visitValueBranches(bgNode, branch => {
            const val = staticString(branch);
            if (!val) return;
            const match = TRANSLUCENT_SURFACE_RE.exec(val);
            if (match && Number(match[1]) < 95) {
              context.report({
                node: branch,
                message: isAlwaysSolidSurface
                  ? "4-Tier Material Ladder Rule: Settings Window (Level 3) must remain 100% solid opaque var(--color-surface*)."
                  : "Wayland Graceful Solid Fallback Rule: do not paint translucent glass surfaces (Levels 1A/1B/2) without compositor backdrop blur (ext_background_effect_v1); use opaque var(--color-surface-container*).",
              });
            }
          });
        },
      };
    },
  },

  "concentric-geometry": {
    meta: {
      type: "problem",
      docs: { description: "Enforce Concentric Shape Scale & Geometry Contract on Floating Dock (R=22px outer, 10-12px inner tiles), Quick Tile icon wells (circular 999px or concentric <=6px), and nested bar badge/IME pills" },
      schema: [],
    },
    create(context) {
      const basename = path.basename(context.filename ?? "");
      if (basename !== "DockSurface.tsx" && basename !== "QuickSettingsPanel.tsx" && basename !== "StatusBar.tsx") return {};
      let aliases = new Map();
      const getStringAttr = (opening, name) => {
        const attr = getAttr(opening, name);
        if (!attr?.value) return null;
        if (attr.value.type === "Literal" && typeof attr.value.value === "string") return attr.value.value;
        if (attr.value.type === "JSXExpressionContainer") return staticString(attr.value.expression);
        return null;
      };
      return {
        Program(program) {
          aliases = collectStringAliases(program);
        },
        VariableDeclarator(node) {
          if (basename !== "DockSurface.tsx" || node.id?.type !== "Identifier" || node.id.name !== "capsule") return;
          const init = node.init?.type === "TSSatisfiesExpression" || node.init?.type === "TSAsExpression"
            ? node.init.expression
            : node.init;
          if (!init || init.type !== "ObjectExpression") return;
          const { map } = getStyleProps(init);
          const radiusNode = map.get("borderRadius") ?? map.get("border-radius");
          const val = resolveStaticText(radiusNode, aliases)?.trim();
          if (val && val !== "22px" && val !== "var(--radius-panel)") {
            context.report({
              node: radiusNode,
              message: `Concentric Floating Dock Rule: Dock capsule must use R=22px (22px or var(--radius-panel)) to stay concentric with 10-12px icons at 10px inset, got "${val}".`,
            });
          }
        },
        JSXOpeningElement(node) {
          const styleAttr = getAttr(node, "style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          if (!styleExpr || styleExpr.type !== "ObjectExpression") return;
          const { map } = getStyleProps(styleExpr);
          const radiusNode = map.get("borderRadius") ?? map.get("border-radius");

          if (basename === "DockSurface.tsx") {
            const testId = getStringAttr(node, "testId");
            const isDockVisual = Boolean(getAttr(node, "data-dock-visual"));
            if ((testId === "dock-launcher" || isDockVisual) && radiusNode) {
              const px = parsePx(radiusNode, aliases);
              if (px !== null && (px < 10 || px > 12)) {
                context.report({
                  node: radiusNode,
                  message: `Concentric Floating Dock Rule: Dock inner tiles must use 10px-12px radius (22px outer - 10px inset = 12px ±2px), got "${px}px".`,
                });
              }
            }
          }

          if (basename === "QuickSettingsPanel.tsx") {
            const isTileIconWell = Boolean(getAttr(node, "data-qs-tile-icon"));
            if (!isTileIconWell) return;
            const val = radiusNode ? resolveStaticText(radiusNode, aliases)?.trim() : null;
            const px = radiusNode ? parsePx(radiusNode, aliases) : null;
            const isValid = val === "999px" || val === "var(--radius-pill)" || (px !== null && px <= 6);
            if (!isValid) {
              context.report({
                node: radiusNode ?? node,
                message:
                  "Concentric Quick Tile Rule: icon well inside 50px (R=14px) QuickTile must use circular borderRadius (999px / var(--radius-pill)) or concentric <=6px radius.",
              });
            }
          }

          if (basename === "StatusBar.tsx") {
            const testId = getStringAttr(node, "testId");
            if (testId === "bar-notifications-badge" || testId === "bar-ime") {
              const text = context.sourceCode?.getText?.(styleExpr) ?? "";
              if (!text.includes("vertical") || !text.includes("maxWidth")) {
                context.report({
                  node: styleExpr,
                  message: `Concentric Bar Pill Rule: nested pill "${testId}" must bound vertical maxWidth/padding so it never overflows or overlaps the 34px/40px vertical bar capsule border.`,
                });
              }
              const bgNode = map.get("backgroundColor") ?? map.get("background-color");
              const staticBgRole = bgNode ? resolveColorRole(bgNode, aliases) : null;
              if (staticBgRole === "primary-container" || (!bgNode && !text.includes("onActiveContainer"))) {
                context.report({
                  node: bgNode ?? styleExpr,
                  message: `Concentric Bar Pill Rule: nested pill "${testId}" must separate its fill from an active primary-container parent capsule instead of painting flat primary-container on primary-container.`,
                });
              }
            }
          }
        },
      };
    },
  },

  "scoped-dismiss-instant": {
    meta: {
      type: "problem",
      docs: { description: "Restrict dismissInstant() strictly to compositor-forced PopupSurface onDismiss handlers so programmatic/Esc dismisses play fast asymmetric exits" },
      schema: [],
    },
    create(context) {
      const filename = (context.filename ?? "").replace(/\\/g, "/");
      if (
        filename.endsWith("/packages/sdk/src/zgui-motion.ts") ||
        filename.endsWith("packages/sdk/src/zgui-motion.ts") ||
        filename.endsWith("/apps/shell/src/motion.ts") ||
        filename.endsWith("apps/shell/src/motion.ts")
      ) {
        return {};
      }
      const dismissCalls = [];
      const functionRefs = new Map();
      const popupDismissRefs = new Set();

      const enclosingNamedHelper = node => {
        let cur = node.parent;
        while (cur) {
          if (cur.type === "JSXAttribute") {
            const el = cur.parent;
            const isPopupOnDismiss =
              cur.name?.type === "JSXIdentifier" &&
              cur.name.name === "onDismiss" &&
              el?.type === "JSXOpeningElement" &&
              el.name?.type === "JSXIdentifier" &&
              el.name.name === "PopupSurface";
            return { inlinePopupOnDismiss: isPopupOnDismiss, helperName: null };
          }
          if (cur.type === "VariableDeclarator" && cur.id?.type === "Identifier") {
            return { inlinePopupOnDismiss: false, helperName: cur.id.name };
          }
          if (cur.type === "FunctionDeclaration" && cur.id?.type === "Identifier") {
            return { inlinePopupOnDismiss: false, helperName: cur.id.name };
          }
          cur = cur.parent;
        }
        return { inlinePopupOnDismiss: false, helperName: null };
      };

      return {
        CallExpression(node) {
          const callee = node.callee;
          const isDismissInstant =
            callee?.type === "MemberExpression" &&
            !callee.computed &&
            callee.property?.type === "Identifier" &&
            callee.property.name === "dismissInstant";
          if (isDismissInstant) dismissCalls.push(node);
        },
        Identifier(node) {
          const parent = node.parent;
          if (!parent) return;
          if (parent.type === "VariableDeclarator" && parent.id === node) return;
          if (parent.type === "FunctionDeclaration" && parent.id === node) return;
          if (parent.type === "MemberExpression" && !parent.computed && parent.property === node) return;
          if (parent.type === "Property" && !parent.computed && parent.key === node) return;

          const count = functionRefs.get(node.name) ?? 0;
          functionRefs.set(node.name, count + 1);

          if (
            parent.type === "JSXExpressionContainer" &&
            parent.parent?.type === "JSXAttribute" &&
            parent.parent.name?.type === "JSXIdentifier" &&
            parent.parent.name.name === "onDismiss" &&
            parent.parent.parent?.type === "JSXOpeningElement" &&
            parent.parent.parent.name?.type === "JSXIdentifier" &&
            parent.parent.parent.name.name === "PopupSurface"
          ) {
            popupDismissRefs.add(node.name);
          }
        },
        "Program:exit"() {
          for (const call of dismissCalls) {
            const scope = enclosingNamedHelper(call);
            if (scope.inlinePopupOnDismiss) continue;
            if (
              scope.helperName &&
              popupDismissRefs.has(scope.helperName) &&
              functionRefs.get(scope.helperName) === 1
            ) {
              continue;
            }
            context.report({
              node: call,
              message:
                "Asymmetric Exit Rule (docs/design/motion.md §5.9): reserve dismissInstant() strictly for compositor-forced <PopupSurface onDismiss={...}> callbacks; programmatic, Esc, and toggle dismisses must play the fast asymmetric exit.",
            });
          }
        },
      };
    },
  },

  "no-duplicate-primitives": {
    meta: {
      type: "problem",
      docs: { description: "Enforce shared M3 desktop primitives: ban hand-rolled switches and slider thumbs outside packages/sdk/src/zgui-primitives.tsx" },
      schema: [],
    },
    create(context) {
      const filename = (context.filename ?? "").replace(/\\/g, "/");
      const basename = path.basename(filename);
      if (basename === "zgui-primitives.tsx") return {};
      return {
        JSXAttribute(node) {
          if (node.name?.type !== "JSXIdentifier") return;
          if (node.name.name === "data-switch-root") {
            context.report({
              node,
              message:
                "Shared Primitive Rule: do not hand-roll toggle switches; import M3Switch from @z-shell/sdk/primitives.",
            });
          } else if (node.name.name === "data-slider-thumb" && basename !== "MediaPanel.tsx") {
            context.report({
              node,
              message:
                "Shared Primitive Rule: do not hand-roll slider tracks/thumbs; import M3Slider or M3SliderRow from @z-shell/sdk/primitives.",
            });
          }
        },
      };
    },
  },

  "interactive-hover-radius": {
    meta: {
      type: "problem",
      docs: { description: "Require explicit borderRadius on inline-styled interactive <Button>/<control> elements so universal M3 :hover/:active state layers never paint sharp-cornered rectangles" },
      schema: [],
    },
    create(context) {
      const filename = (context.filename ?? "").replace(/\\/g, "/");
      if (filename.endsWith("packages/sdk/src/zgui-primitives.tsx")) return {};
      const roundedStyleConsts = new Set();
      const roundedStyleFns = new Set();

      const exprDefinesRadius = expr => {
        if (!expr) return false;
        const unwrapped =
          expr.type === "TSSatisfiesExpression" || expr.type === "TSAsExpression" ? expr.expression : expr;
        if (unwrapped.type === "ObjectExpression") {
          const { map } = getStyleProps(unwrapped);
          if (map.has("borderRadius") || map.has("border-radius")) return true;
          for (const prop of unwrapped.properties ?? []) {
            if (prop.type === "SpreadElement") {
              if (prop.argument?.type === "Identifier" && roundedStyleConsts.has(prop.argument.name)) return true;
              if (
                prop.argument?.type === "CallExpression" &&
                prop.argument.callee?.type === "Identifier" &&
                roundedStyleFns.has(prop.argument.callee.name)
              ) {
                return true;
              }
            }
          }
          return false;
        }
        if (unwrapped.type === "ConditionalExpression") {
          return exprDefinesRadius(unwrapped.consequent) && exprDefinesRadius(unwrapped.alternate);
        }
        if (unwrapped.type === "Identifier") return roundedStyleConsts.has(unwrapped.name);
        if (unwrapped.type === "CallExpression" && unwrapped.callee?.type === "Identifier") {
          return roundedStyleFns.has(unwrapped.callee.name);
        }
        return false;
      };

      const checkRoleExempt = roleAttr => {
        if (!roleAttr?.value) return false;
        const exemptRoles = new Set(["slider", "progressIndicator", "progressBar"]);
        const isExemptNode = expr => {
          const val = staticString(expr);
          if (val !== null) return exemptRoles.has(val);
          if (expr?.type === "ConditionalExpression") {
            return isExemptNode(expr.consequent) && isExemptNode(expr.alternate);
          }
          return false;
        };
        if (roleAttr.value.type === "Literal") return exemptRoles.has(roleAttr.value.value);
        if (roleAttr.value.type === "JSXExpressionContainer") return isExemptNode(roleAttr.value.expression);
        return false;
      };

      return {
        Program(program) {
          const scanStatements = stmts => {
            for (const stmt of stmts ?? []) {
              const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
              if (!decl) continue;
              if (decl.type === "VariableDeclaration") {
                for (const item of decl.declarations ?? []) {
                  if (item.id?.type !== "Identifier" || !item.init) continue;
                  const init = item.init;
                  if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
                    const bodyText = context.sourceCode?.getText?.(init) ?? "";
                    if (bodyText.includes("borderRadius") || [...roundedStyleConsts].some(id => bodyText.includes(id))) {
                      roundedStyleFns.add(item.id.name);
                    }
                  } else if (exprDefinesRadius(init)) {
                    roundedStyleConsts.add(item.id.name);
                  }
                }
              } else if (decl.type === "FunctionDeclaration" && decl.id?.type === "Identifier") {
                const bodyText = context.sourceCode?.getText?.(decl) ?? "";
                if (bodyText.includes("borderRadius") || [...roundedStyleConsts].some(id => bodyText.includes(id))) {
                  roundedStyleFns.add(decl.id.name);
                }
              }
            }
          };
          scanStatements(program.body);
        },
        VariableDeclarator(node) {
          if (node.id?.type !== "Identifier" || !node.init) return;
          if (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression") {
            const bodyText = context.sourceCode?.getText?.(node.init) ?? "";
            if (bodyText.includes("borderRadius") || [...roundedStyleConsts].some(id => bodyText.includes(id))) {
              roundedStyleFns.add(node.id.name);
            }
          } else if (exprDefinesRadius(node.init)) {
            roundedStyleConsts.add(node.id.name);
          }
        },
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier") return;
          const tag = node.name.name;
          if (tag !== "Button" && tag !== "control") return;
          const attrs = node.attributes ?? [];
          const findAttr = name =>
            attrs.find(attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === name);
          // CSS Module classes and specialized non-inset interactive controls are exempt.
          if (
            findAttr("class") ||
            findAttr("data-switch-root") ||
            findAttr("data-dock-item") ||
            findAttr("data-bar-segment") ||
            checkRoleExempt(findAttr("role"))
          ) {
            return;
          }
          const styleAttr = findAttr("style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          if (!styleExpr) return;
          if (!exprDefinesRadius(styleExpr)) {
            context.report({
              node: styleAttr,
              message: `Interactive Hover Radius Rule: inline-styled <${tag}> must declare borderRadius so universal M3 :hover/:active state layers never paint sharp-cornered rectangles.`,
            });
          }
        },
      };
    },
  },

  "centered-text-badge": {
    meta: {
      type: "problem",
      docs: { description: "Require flex vertical centering and explicit small-text lineHeight on styled <box>/<row> badges wrapping <text> so keycaps and status pills never drift off-center" },
      schema: [],
    },
    create(context) {
      let aliases = new Map();
      const styleMeta = new Map();

      const unwrap = expr =>
        expr && (expr.type === "TSSatisfiesExpression" || expr.type === "TSAsExpression") ? expr.expression : expr;

      const analyzeStyleExpr = expr => {
        const result = {
          hasFlex: false,
          hasAlignCenter: false,
          hasJustifyCenter: false,
          isColumn: false,
          hasSurface: false,
          hasLineHeight: false,
        };
        const node = unwrap(expr);
        if (!node) return result;
        if (node.type === "Identifier") {
          return styleMeta.get(node.name) ?? result;
        }
        if (node.type !== "ObjectExpression") return result;

        for (const prop of node.properties ?? []) {
          if (prop.type === "SpreadElement") {
            const arg = unwrap(prop.argument);
            const spread =
              arg?.type === "Identifier"
                ? styleMeta.get(arg.name)
                : arg?.type === "ObjectExpression"
                  ? analyzeStyleExpr(arg)
                  : null;
            if (spread) {
              result.hasFlex ||= spread.hasFlex;
              result.hasAlignCenter ||= spread.hasAlignCenter;
              result.hasJustifyCenter ||= spread.hasJustifyCenter;
              result.isColumn ||= spread.isColumn;
              result.hasSurface ||= spread.hasSurface;
              result.hasLineHeight ||= spread.hasLineHeight;
            }
            continue;
          }
          const key = propertyName(prop);
          if (!key) continue;
          const strVal = resolveStaticText(prop.value, aliases)?.trim();
          if (key === "display" && strVal === "flex") result.hasFlex = true;
          if ((key === "alignItems" || key === "align-items") && strVal === "center") result.hasAlignCenter = true;
          if ((key === "justifyContent" || key === "justify-content") && strVal === "center") result.hasJustifyCenter = true;
          if ((key === "flexDirection" || key === "flex-direction") && strVal === "column") result.isColumn = true;
          if (key === "lineHeight" || key === "line-height") result.hasLineHeight = true;
          if (
            key === "borderRadius" ||
            key === "border-radius" ||
            key === "backgroundColor" ||
            key === "background-color" ||
            key === "border"
          ) {
            result.hasSurface = true;
          }
        }
        return result;
      };

      const recordStyleConst = item => {
        if (item.id?.type !== "Identifier" || !item.init) return;
        const init = unwrap(item.init);
        if (init?.type === "ObjectExpression") {
          styleMeta.set(item.id.name, analyzeStyleExpr(init));
        }
      };

      const LEAF_BADGE_TAGS = new Set(["text", "ShellIcon", "vector", "Image"]);

      return {
        Program(program) {
          aliases = collectStringAliases(program);
          for (const stmt of program.body ?? []) {
            const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
            if (decl?.type === "VariableDeclaration") {
              for (const item of decl.declarations ?? []) recordStyleConst(item);
            }
          }
        },
        VariableDeclarator(node) {
          recordStyleConst(node);
        },
        JSXElement(node) {
          const opening = node.openingElement;
          if (opening?.name?.type !== "JSXIdentifier") return;
          const tag = opening.name.name;
          if (tag !== "box" && tag !== "row") return;
          const attrs = opening.attributes ?? [];
          const findAttr = name =>
            attrs.find(attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === name);
          if (findAttr("class")) return;
          const styleAttr = findAttr("style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          if (!styleExpr) return;

          const directElements = [];
          for (const child of node.children ?? []) {
            if (child.type === "JSXText" && child.value.trim() === "") continue;
            if (child.type === "JSXExpressionContainer") {
              if (child.expression?.type === "JSXEmptyExpression") continue;
              // Expressions like <Show> or dynamic child arrays indicate non-leaf containers.
              return;
            }
            if (child.type !== "JSXElement") return;
            const childTag = child.openingElement?.name?.type === "JSXIdentifier" ? child.openingElement.name.name : null;
            if (!childTag || !LEAF_BADGE_TAGS.has(childTag)) return;
            directElements.push({ child, tag: childTag });
          }
          const textChildren = directElements.filter(entry => entry.tag === "text");
          if (textChildren.length === 0) return;

          const meta = analyzeStyleExpr(styleExpr);
          if (!meta.hasSurface) return;

          const hasFlex = tag === "row" || meta.hasFlex;
          const centeredVertically = meta.isColumn ? meta.hasJustifyCenter : meta.hasAlignCenter;
          if (!hasFlex || !centeredVertically) {
            context.report({
              node: styleAttr,
              message: `Centered Text Badge Rule: styled <${tag}> badge wrapping <text> must use flex vertical centering (display: "flex", ${meta.isColumn ? 'justifyContent: "center"' : 'alignItems: "center"'}) so keycaps and pills never drift off-center.`,
            });
          }

          for (const { child } of textChildren) {
            const textStyleAttr = (child.openingElement?.attributes ?? []).find(
              attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "style",
            );
            const textStyleExpr = textStyleAttr?.value?.type === "JSXExpressionContainer" ? unwrap(textStyleAttr.value.expression) : null;
            if (!textStyleExpr || textStyleExpr.type !== "ObjectExpression") continue;
            const { map } = getStyleProps(textStyleExpr);
            const fontSizeNode = map.get("fontSize") ?? map.get("font-size");
            const fontSizePx = fontSizeNode ? parsePx(fontSizeNode, aliases) : null;
            if (fontSizePx !== null && fontSizePx <= 12) {
              const textMeta = analyzeStyleExpr(textStyleExpr);
              if (!textMeta.hasLineHeight && !meta.hasLineHeight) {
                context.report({
                  node: textStyleAttr,
                  message: `Centered Text Badge Rule: compact badge <text> (fontSize ${fontSizePx}px <= 12px) must declare an explicit lineHeight (on <text> or its badge container) so inherited body line-height never shifts the glyph off vertical center.`,
                });
              }
            }
          }
        },
      };
    },
  },

  "no-partial-card-hover": {
    meta: {
      type: "problem",
      docs: { description: "Disallow negative margins on <Button>/<control> elements used to expand hover hit targets inside cards" },
      schema: [],
    },
    create(context) {
      let aliases = new Map();
      const negativeMarginConsts = new Map();
      const MARGIN_KEYS = new Set([
        "margin",
        "marginTop",
        "marginRight",
        "marginBottom",
        "marginLeft",
        "margin-top",
        "margin-right",
        "margin-bottom",
        "margin-left",
        "marginInline",
        "marginBlock",
        "marginInlineStart",
        "marginInlineEnd",
        "marginBlockStart",
        "marginBlockEnd",
        "margin-inline",
        "margin-block",
        "margin-inline-start",
        "margin-inline-end",
        "margin-block-start",
        "margin-block-end",
      ]);

      const unwrap = expr =>
        expr && (expr.type === "TSSatisfiesExpression" || expr.type === "TSAsExpression") ? expr.expression : expr;

      const findNegativeMarginValue = expr => {
        const node = unwrap(expr);
        if (!node) return null;
        if (node.type === "UnaryExpression" && node.operator === "-") {
          const arg = unwrap(node.argument);
          if (arg?.type === "Literal" && typeof arg.value === "number" && arg.value > 0) {
            return `-${arg.value}`;
          }
        }
        const text = resolveStaticText(node, aliases);
        if (text !== null && /(?:^|\s)-\d/.test(text.trim())) {
          return JSON.stringify(text);
        }
        if (node.type === "ConditionalExpression") {
          return findNegativeMarginValue(node.consequent) ?? findNegativeMarginValue(node.alternate);
        }
        return null;
      };

      const findNegativeMarginInStyle = expr => {
        const node = unwrap(expr);
        if (!node) return null;
        if (node.type === "Identifier") {
          return negativeMarginConsts.get(node.name) ?? null;
        }
        if (node.type === "ConditionalExpression") {
          return findNegativeMarginInStyle(node.consequent) ?? findNegativeMarginInStyle(node.alternate);
        }
        if (node.type !== "ObjectExpression") return null;

        for (const prop of node.properties ?? []) {
          if (prop.type === "SpreadElement") {
            const spreadHit = findNegativeMarginInStyle(prop.argument);
            if (spreadHit) return spreadHit;
            continue;
          }
          const key = propertyName(prop);
          if (!key || !MARGIN_KEYS.has(key)) continue;
          const neg = findNegativeMarginValue(prop.value);
          if (neg !== null) return { key, value: neg, node: prop };
        }
        return null;
      };

      const recordStyleConst = item => {
        if (item.id?.type !== "Identifier" || !item.init) return;
        const hit = findNegativeMarginInStyle(item.init);
        if (hit) negativeMarginConsts.set(item.id.name, hit);
      };

      return {
        Program(program) {
          aliases = collectStringAliases(program);
          for (const stmt of program.body ?? []) {
            const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
            if (decl?.type === "VariableDeclaration") {
              for (const item of decl.declarations ?? []) recordStyleConst(item);
            }
          }
        },
        VariableDeclarator(node) {
          recordStyleConst(node);
        },
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier") return;
          const tag = node.name.name;
          if (tag !== "Button" && tag !== "control") return;
          const styleAttr = (node.attributes ?? []).find(
            attr => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === "style",
          );
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          if (!styleExpr) return;
          const hit = findNegativeMarginInStyle(styleExpr);
          if (hit) {
            context.report({
              node: styleAttr,
              message: `Partial Card Hover Rule: <${tag}> must not use negative margin (${hit.key}: ${hit.value}) to stretch hover hits inside a card — this causes clipped box-in-box hover highlights. Use M3InteractiveCard (stretched full-card hit layer) or SplitTile instead.`,
            });
          }
        },
      };
    },
  },

  "consistent-active-hover-shape": {
    meta: {
      type: "problem",
      docs: { description: "Enforce identical outer contour between [data-active] / [data-active-indicator] active chrome and interactive hover <Button> hit boxes" },
      schema: [],
    },
    create(context) {
      const filename = (context.filename ?? "").replace(/\\/g, "/");
      const isPluginWidget = /(?:^|\/)plugins\/[^/]+\/src\/widget\.tsx$/.test(filename);
      let aliases = new Map();
      const functionMap = new Map();

      const unwrap = expr =>
        expr && (expr.type === "TSSatisfiesExpression" || expr.type === "TSAsExpression") ? expr.expression : expr;

      const parsePaddingEdges = valueExpr => {
        const text = resolveStaticText(unwrap(valueExpr), aliases);
        if (text === null) return null;
        const parts = text.trim().split(/\s+/).map(part => {
          if (part === "0") return 0;
          const m = /^(-?\d+(?:\.\d+)?)px$/i.exec(part);
          return m ? Number(m[1]) : null;
        });
        if (parts.some(v => v === null)) return null;
        if (parts.length === 1) return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
        if (parts.length === 2) return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
        if (parts.length === 3) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
        if (parts.length === 4) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
        return null;
      };

      const hasNonZeroPadding = styleExpr => {
        let hit = false;
        visitValueBranches(unwrap(styleExpr), branch => {
          const obj = unwrap(branch);
          if (!obj || obj.type !== "ObjectExpression") return;
          const { map } = getStyleProps(obj);
          for (const key of ["padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
            const val = map.get(key);
            if (!val) continue;
            visitValueBranches(val, leaf => {
              const edges = parsePaddingEdges(leaf);
              if (edges && (edges.top > 0 || edges.right > 0 || edges.bottom > 0 || edges.left > 0)) {
                hit = true;
              }
            });
          }
        });
        return hit;
      };

      const collectRadiusStrings = (styleExpr, out = []) => {
        visitValueBranches(unwrap(styleExpr), branch => {
          const obj = unwrap(branch);
          if (!obj || obj.type !== "ObjectExpression") return;
          const { map } = getStyleProps(obj);
          const radius = map.get("borderRadius") ?? map.get("border-radius");
          if (!radius) return;
          visitValueBranches(radius, leaf => {
            const str = resolveStaticText(unwrap(leaf), aliases);
            if (str !== null) out.push(str.trim());
          });
        });
        return out;
      };

      const collectJsxElements = (root, cb) => {
        const walk = node => {
          if (!node || typeof node !== "object") return;
          if (node.type === "JSXElement") {
            cb(node);
            for (const child of node.children ?? []) walk(child);
            for (const attr of node.openingElement?.attributes ?? []) {
              if (attr.type === "JSXAttribute" && attr.value?.type === "JSXExpressionContainer") {
                walk(attr.value.expression);
              }
            }
            return;
          }
          for (const key of Object.keys(node)) {
            if (key === "parent") continue;
            const val = node[key];
            if (Array.isArray(val)) {
              for (const item of val) walk(item);
            } else if (val && typeof val === "object" && val.type) {
              walk(val);
            }
          }
        };
        walk(root);
      };

      const findPropExpr = (opening, name) => {
        const attr = getAttr(opening, name);
        return attr?.value?.type === "JSXExpressionContainer" ? attr.value.expression : attr?.value ?? null;
      };

      return {
        Program(program) {
          aliases = collectStringAliases(program);
          for (const stmt of program.body ?? []) {
            if (stmt.type === "FunctionDeclaration" && stmt.id?.name) {
              functionMap.set(stmt.id.name, stmt);
            }
          }
        },
        JSXElement(element) {
          const opening = element.openingElement;
          if (opening?.name?.type !== "JSXIdentifier") return;
          const tag = opening.name.name;
          const styleExpr = findPropExpr(opening, "style");

          if (isPluginWidget && tag === "Button" && styleExpr) {
            const radii = collectRadiusStrings(styleExpr);
            if (radii.some(r => r !== "inherit")) {
              context.report({
                node: styleExpr,
                message: `Consistent Active/Hover Shape Rule: plugin widget root <Button> must use borderRadius: "inherit" so its hover highlight matches the host slot active capsule (found ${radii.join(", ")}).`,
              });
            }
          }

          if ((tag === "box" || tag === "row" || tag === "column") && getAttr(opening, "data-active") && styleExpr) {
            if (hasNonZeroPadding(styleExpr)) {
              context.report({
                node: styleExpr,
                message: "Consistent Active/Hover Shape Rule: non-interactive [data-active] wrapper must use zero padding (padding: 0px) so child interactive hover fills the full active surface.",
              });
            }
            for (const child of element.children ?? []) {
              collectJsxElements(child, desc => {
                const descTag = desc.openingElement?.name?.name;
                if (descTag !== "Button" && descTag !== "control") return;
                const btnStyle = findPropExpr(desc.openingElement, "style");
                if (!btnStyle) return;
                const radii = collectRadiusStrings(btnStyle);
                if (radii.some(r => r !== "inherit")) {
                  context.report({
                    node: btnStyle,
                    message: `Consistent Active/Hover Shape Rule: <${descTag}> inside [data-active] wrapper must use borderRadius: "inherit" so hover and active shapes match (found ${radii.join(", ")}).`,
                  });
                }
              });
            }
          }

          if (getAttr(opening, "data-active-indicator") && styleExpr) {
            const indicatorRadii = collectRadiusStrings(styleExpr);
            let badInset = false;
            visitValueBranches(unwrap(styleExpr), branch => {
              const obj = unwrap(branch);
              if (!obj || obj.type !== "ObjectExpression") return;
              const { map } = getStyleProps(obj);
              for (const edge of ["left", "top"]) {
                const edgeVal = map.get(edge);
                if (!edgeVal) continue;
                visitValueBranches(edgeVal, leaf => {
                  const px = parsePx(leaf, aliases);
                  if (px !== null && px !== 0) badInset = true;
                });
              }
            });
            if (badInset) {
              context.report({
                node: styleExpr,
                message: "Consistent Active/Hover Shape Rule: [data-active-indicator] must align flush (left: 0px, top: 0px) with its target <Button> hit box instead of shrinking inward.",
              });
            }
            const parentEl = element.parent?.type === "JSXElement" ? element.parent : null;
            if (parentEl && indicatorRadii.length > 0) {
              const pairedBtnRadii = [];
              collectJsxElements(parentEl, desc => {
                const descTag = desc.openingElement?.name?.name;
                if (descTag === "Button" || descTag === "control") {
                  const btnStyle = findPropExpr(desc.openingElement, "style");
                  if (btnStyle) pairedBtnRadii.push(...collectRadiusStrings(btnStyle));
                } else if (descTag && /^[A-Z]/.test(descTag) && functionMap.has(descTag)) {
                  collectJsxElements(functionMap.get(descTag), fnEl => {
                    const fnTag = fnEl.openingElement?.name?.name;
                    if (fnTag === "Button" || fnTag === "control") {
                      const btnStyle = findPropExpr(fnEl.openingElement, "style");
                      if (btnStyle) pairedBtnRadii.push(...collectRadiusStrings(btnStyle));
                    }
                  });
                }
              });
              if (
                pairedBtnRadii.length > 0
                && JSON.stringify([...new Set(indicatorRadii)].sort()) !== JSON.stringify([...new Set(pairedBtnRadii)].sort())
              ) {
                context.report({
                  node: styleExpr,
                  message: `Consistent Active/Hover Shape Rule: [data-active-indicator] borderRadius (${[...new Set(indicatorRadii)].join(", ")}) must match its paired <Button> borderRadius (${[...new Set(pairedBtnRadii)].join(", ")}).`,
                });
              }
            }
          }
        },
      };
    },
  },

  "no-child-control-overflow": {
    meta: {
      type: "problem",
      docs: { description: "Disallow interactive <Button>/<control> children whose static width/height exceeds their enclosing bar container's cross-axis bounds" },
      schema: [],
    },
    create(context) {
      let aliases = new Map();
      const styleConsts = new Map();

      const unwrap = expr =>
        expr && (expr.type === "TSSatisfiesExpression" || expr.type === "TSAsExpression") ? expr.expression : expr;

      const resolveConstProps = (expr, branches) => {
        const node = unwrap(expr);
        if (!node) return null;
        if (node.type === "Identifier") {
          const cached = styleConsts.get(node.name);
          return cached ? resolveConstProps(cached, branches) : null;
        }
        if (node.type === "ConditionalExpression") {
          const cond = node.test?.type === "CallExpression" && node.test.callee?.type === "Identifier"
            ? node.test.callee.name
            : null;
          if (cond === "vertical" || cond === "docked") {
            const key = `${cond}:${branches[cond] ?? "true"}`;
            const pick = key.endsWith(":true") ? node.consequent : node.alternate;
            return resolveConstProps(pick, branches);
          }
          return null;
        }
        if (node.type !== "ObjectExpression") return null;
        const merged = new Map();
        for (const prop of node.properties ?? []) {
          if (prop.type === "SpreadElement") {
            const sub = resolveConstProps(prop.argument, branches);
            if (sub) {
              for (const [k, v] of sub) merged.set(k, v);
            }
            continue;
          }
          const k = propertyName(prop);
          if (k) merged.set(k, prop.value);
        }
        return merged;
      };

      const evalPxProp = (propExpr, branches) => {
        const node = unwrap(propExpr);
        if (!node) return null;
        if (node.type === "ConditionalExpression") {
          const cond = node.test?.type === "CallExpression" && node.test.callee?.type === "Identifier"
            ? node.test.callee.name
            : null;
          if (cond === "vertical" || cond === "docked") {
            const pick = branches[cond] ? node.consequent : node.alternate;
            return evalPxProp(pick, branches);
          }
          return null;
        }
        return parsePx(node, aliases);
      };

      const evalPadding = (map, branches) => {
        const padNode = map.get("padding");
        if (!padNode) return { x: 0, y: 0 };
        const str = (() => {
          const node = unwrap(padNode);
          if (node?.type === "ConditionalExpression") {
            const cond = node.test?.type === "CallExpression" && node.test.callee?.type === "Identifier"
              ? node.test.callee.name
              : null;
            if (cond === "vertical" || cond === "docked") {
              return resolveStaticText(unwrap(branches[cond] ? node.consequent : node.alternate), aliases);
            }
          }
          return resolveStaticText(node, aliases);
        })();
        if (str === null) return { x: 0, y: 0 };
        const nums = str.trim().split(/\s+/).map(p => (p === "0" ? 0 : (/^(\d+(?:\.\d+)?)px$/i.exec(p)?.[1] ? Number(/^(\d+(?:\.\d+)?)px$/i.exec(p)[1]) : null)));
        if (nums.some(n => n === null)) return { x: 0, y: 0 };
        if (nums.length === 1) return { x: nums[0] * 2, y: nums[0] * 2 };
        if (nums.length === 2) return { x: nums[1] * 2, y: nums[0] * 2 };
        if (nums.length === 3) return { x: nums[1] * 2, y: nums[0] + nums[2] };
        if (nums.length === 4) return { x: nums[1] + nums[3], y: nums[0] + nums[2] };
        return { x: 0, y: 0 };
      };

      const findDirectChildButtons = (children, out = []) => {
        for (const child of children ?? []) {
          if (child.type !== "JSXElement") continue;
          const tag = child.openingElement?.name?.name;
          if (tag === "Button" || tag === "control") {
            out.push(child.openingElement);
          } else if (tag === "Show" || tag === "For" || tag === "Match" || tag === "Switch") {
            findDirectChildButtons(child.children, out);
          }
        }
        return out;
      };

      return {
        Program(program) {
          aliases = collectStringAliases(program);
          for (const stmt of program.body ?? []) {
            const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
            if (decl?.type === "VariableDeclaration" && decl.kind === "const") {
              for (const item of decl.declarations ?? []) {
                if (item.id?.type === "Identifier" && item.init) styleConsts.set(item.id.name, item.init);
              }
            }
          }
        },
        JSXElement(element) {
          const opening = element.openingElement;
          if (opening?.name?.type !== "JSXIdentifier") return;
          const tag = opening.name.name;
          if (tag !== "box" && tag !== "row" && tag !== "column") return;
          const styleAttr = getAttr(opening, "style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          if (!styleExpr) return;

          const childButtons = findDirectChildButtons(element.children);
          if (childButtons.length === 0) return;

          for (const vertical of [false, true]) {
            for (const docked of [false, true]) {
              const branches = { vertical, docked };
              const parentProps = resolveConstProps(styleExpr, branches);
              if (!parentProps) continue;
              const pw = parentProps.has("width") ? evalPxProp(parentProps.get("width"), branches) : null;
              const ph = parentProps.has("height") ? evalPxProp(parentProps.get("height"), branches) : null;
              if (pw === null && ph === null) continue;
              const pad = evalPadding(parentProps, branches);

              for (const btn of childButtons) {
                const btnStyleAttr = getAttr(btn, "style");
                const btnStyleExpr = btnStyleAttr?.value?.type === "JSXExpressionContainer" ? btnStyleAttr.value.expression : null;
                if (!btnStyleExpr) continue;
                const btnProps = resolveConstProps(btnStyleExpr, branches);
                if (!btnProps) continue;
                const cw = btnProps.has("width") ? evalPxProp(btnProps.get("width"), branches) : null;
                const ch = btnProps.has("height") ? evalPxProp(btnProps.get("height"), branches) : null;
                if (pw !== null && cw !== null && cw + pad.x > pw) {
                  context.report({
                    node: btnStyleAttr,
                    message: `Child Control Overflow Rule: child <${btn.name.name}> width (${cw}px + ${pad.x}px padding) exceeds parent <${tag}> width (${pw}px) in ${vertical ? "vertical" : "horizontal"} ${docked ? "docked" : "floating"} mode.`,
                  });
                  return;
                }
                if (ph !== null && ch !== null && ch + pad.y > ph) {
                  context.report({
                    node: btnStyleAttr,
                    message: `Child Control Overflow Rule: child <${btn.name.name}> height (${ch}px + ${pad.y}px padding) exceeds parent <${tag}> height (${ph}px) in ${vertical ? "vertical" : "horizontal"} ${docked ? "docked" : "floating"} mode.`,
                  });
                  return;
                }
              }
            }
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
