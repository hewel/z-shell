import { existsSync, readFileSync } from "node:fs";
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
  if (trimmed === "inherit") return true;
  const parts = trimmed.split(/\s+/);
  for (const part of parts) {
    if (part === "0" || part === "50%" || /^var\(--radius-[a-z0-9-]+\)$/.test(part)) continue;
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

function unwrapTs(expr) {
  let cur = expr;
  while (cur && (cur.type === "TSSatisfiesExpression" || cur.type === "TSAsExpression")) {
    cur = cur.expression;
  }
  return cur;
}

function parseCssPx(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "0") return 0;
  const match = /^(\d+(?:\.\d+)?)px$/i.exec(trimmed);
  return match ? Number(match[1]) : null;
}

function resolveColorRoleFromText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  COLOR_VAR_RE.lastIndex = 0;
  const match = COLOR_VAR_RE.exec(trimmed);
  return match && match[0] === trimmed ? match[1] : null;
}

function parseSpacingEdges(text) {
  if (typeof text !== "string") return null;
  const parts = text.trim().split(/\s+/).map(part => {
    if (part === "0") return 0;
    const m = /^(-?\d+(?:\.\d+)?)px$/i.exec(part);
    return m ? Number(m[1]) : null;
  });
  if (parts.length === 0 || parts.some(v => v === null)) return null;
  if (parts.length === 1) return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  if (parts.length === 2) return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  if (parts.length === 3) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
  if (parts.length === 4) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
  return null;
}

function stripCssComments(css) {
  let out = "";
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < css.length) {
        out += css[i + 1];
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) break;
      out += " ";
      i = end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function splitTopLevel(input, isDelimiter) {
  const parts = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && i + 1 < input.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      parenDepth++;
    } else if (ch === ")" && parenDepth > 0) {
      parenDepth--;
    } else if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]" && bracketDepth > 0) {
      bracketDepth--;
    } else if (parenDepth === 0 && bracketDepth === 0 && isDelimiter(ch)) {
      const slice = input.slice(start, i).trim();
      if (slice.length > 0) parts.push(slice);
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

function extractCssDeclarations(text) {
  const decls = [];
  for (const stmt of splitTopLevel(text, ch => ch === ";")) {
    const colon = stmt.indexOf(":");
    if (colon <= 0) continue;
    const prop = stmt.slice(0, colon).trim().toLowerCase();
    const value = stmt.slice(colon + 1).trim();
    if (prop.length > 0) decls.push({ prop, value });
  }
  return decls;
}

function resolveNestedSelectors(parents, rawSelector) {
  const children = splitTopLevel(rawSelector, ch => ch === ",");
  if (parents.length === 0) return children;
  const resolved = [];
  for (const parent of parents) {
    for (const child of children) {
      resolved.push(child.includes("&") ? child.replaceAll("&", parent) : `${parent} ${child}`);
    }
  }
  return resolved;
}

function rightmostCompoundSelector(selector) {
  const parts = splitTopLevel(selector, ch => ch === ">" || ch === "+" || ch === "~" || /\s/.test(ch));
  return parts.at(-1) ?? "";
}

function stripNotPseudo(selector) {
  let out = "";
  let i = 0;
  while (i < selector.length) {
    if (selector.slice(i, i + 5).toLowerCase() === ":not(") {
      let depth = 1;
      i += 5;
      while (i < selector.length && depth > 0) {
        if (selector[i] === "(") depth++;
        else if (selector[i] === ")") depth--;
        i++;
      }
      continue;
    }
    out += selector[i];
    i++;
  }
  return out;
}

function extractSubjectClasses(compoundSelector) {
  const classes = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote = null;
  for (let i = 0; i < compoundSelector.length; i++) {
    const ch = compoundSelector[i];
    if (quote) {
      if (ch === "\\" && i + 1 < compoundSelector.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") { parenDepth++; continue; }
    if (ch === ")" && parenDepth > 0) { parenDepth--; continue; }
    if (ch === "[") { bracketDepth++; continue; }
    if (ch === "]" && bracketDepth > 0) { bracketDepth--; continue; }
    if (parenDepth === 0 && bracketDepth === 0 && ch === ".") {
      const match = /^\.([A-Za-z_-][A-Za-z0-9_-]*)/.exec(compoundSelector.slice(i));
      if (match) {
        classes.push(match[1]);
        i += match[0].length - 1;
      }
    }
  }
  return classes;
}

function extractAttrMatchers(compoundSelector) {
  const matchers = [];
  let quote = null;
  let parenDepth = 0;
  for (let i = 0; i < compoundSelector.length; i++) {
    const ch = compoundSelector[i];
    if (quote) {
      if (ch === "\\" && i + 1 < compoundSelector.length) { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") { parenDepth++; continue; }
    if (ch === ")" && parenDepth > 0) { parenDepth--; continue; }
    if (parenDepth === 0 && ch === "[") {
      let end = i + 1;
      let innerQuote = null;
      while (end < compoundSelector.length) {
        const c = compoundSelector[end];
        if (innerQuote) {
          if (c === "\\" && end + 1 < compoundSelector.length) { end += 2; continue; }
          if (c === innerQuote) innerQuote = null;
        } else if (c === '"' || c === "'") {
          innerQuote = c;
        } else if (c === "]") {
          break;
        }
        end++;
      }
      const raw = compoundSelector.slice(i + 1, end).trim();
      const eq = raw.indexOf("=");
      if (eq === -1) {
        if (raw) matchers.push({ name: raw, value: null });
      } else {
        const name = raw.slice(0, eq).replace(/[~|^$*]$/, "").trim();
        const val = raw.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
        if (name) matchers.push({ name, value: val });
      }
      i = end;
    }
  }
  return matchers;
}

function parseCssRuleBlocks(body, parentSelectors = [], outKeyframesDecls = []) {
  const blocks = [];
  let inlineText = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote = null;
  let i = 0;

  while (i < body.length) {
    const ch = body[i];
    if (quote) {
      inlineText += ch;
      if (ch === "\\" && i + 1 < body.length) {
        inlineText += body[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inlineText += ch;
      i++;
      continue;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")" && parenDepth > 0) parenDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]" && bracketDepth > 0) bracketDepth--;

    if (parenDepth === 0 && bracketDepth === 0 && ch === "{") {
      const semiIdx = inlineText.lastIndexOf(";");
      const prelude = (semiIdx >= 0 ? inlineText.slice(semiIdx + 1) : inlineText).trim();
      const beforePrelude = semiIdx >= 0 ? inlineText.slice(0, semiIdx + 1) : "";
      if (parentSelectors.length > 0 && beforePrelude.trim().length > 0) {
        const existing = blocks.find(b => b.selectors === parentSelectors);
        const decls = extractCssDeclarations(beforePrelude);
        if (existing) existing.declarations.push(...decls);
        else blocks.push({ selectors: parentSelectors, declarations: decls });
      }
      inlineText = "";

      let depth = 1;
      let j = i + 1;
      let innerQuote = null;
      while (j < body.length && depth > 0) {
        const c = body[j];
        if (innerQuote) {
          if (c === "\\" && j + 1 < body.length) {
            j += 2;
            continue;
          }
          if (c === innerQuote) innerQuote = null;
          j++;
          continue;
        }
        if (c === '"' || c === "'") innerQuote = c;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
        j++;
      }
      const innerBody = body.slice(i + 1, j - 1);
      i = j;

      if (prelude.startsWith("@")) {
        if (/^@(?:-[a-z]+-)?keyframes\b/i.test(prelude)) {
          const kfBlocks = parseCssRuleBlocks(innerBody, []);
          for (const kf of kfBlocks.blocks) outKeyframesDecls.push(...kf.declarations);
        } else {
          blocks.push(...parseCssRuleBlocks(innerBody, parentSelectors, outKeyframesDecls).blocks);
        }
      } else if (prelude.length > 0) {
        const selectors = resolveNestedSelectors(parentSelectors, prelude);
        const ruleBlock = { selectors, declarations: [] };
        blocks.push(ruleBlock);
        blocks.push(...parseCssRuleBlocks(innerBody, selectors, outKeyframesDecls).blocks);
      }
      continue;
    }

    inlineText += ch;
    i++;
  }

  if (parentSelectors.length > 0 && inlineText.trim().length > 0) {
    const decls = extractCssDeclarations(inlineText);
    const existing = blocks.find(b => b.selectors === parentSelectors);
    if (existing) existing.declarations.push(...decls);
    else if (decls.length > 0) blocks.push({ selectors: parentSelectors, declarations: decls });
  }
  return { blocks, keyframesDecls: outKeyframesDecls };
}

const PARSED_CSS_CACHE = new Map();

function parseCssModule(cssText) {
  const cached = PARSED_CSS_CACHE.get(cssText);
  if (cached) return cached;
  const stripped = stripCssComments(cssText);
  const { blocks, keyframesDecls } = parseCssRuleBlocks(stripped);
  const classBlocks = new Map();

  for (const block of blocks) {
    block.isRootRule = block.selectors.every(sel => sel.trim() === ":root");
    block.parsedSelectors = block.selectors.map(selector => {
      const rightmost = rightmostCompoundSelector(selector);
      const subjectClean = stripNotPseudo(rightmost);
      const subjectClasses = extractSubjectClasses(rightmost);
      const attrMatchers = extractAttrMatchers(rightmost);
      const allAttrMatchers = extractAttrMatchers(selector);
      const isHoverOrActive = /:(?:hover|active)\b/i.test(subjectClean);
      const isDisabled = /:disabled\b/i.test(subjectClean);
      const isInteractivePseudo = isHoverOrActive || isDisabled || /:(?:focus|focus-visible|focus-within)\b/i.test(subjectClean);
      return {
        selector,
        rightmost,
        subjectClean,
        subjectClasses,
        attrMatchers,
        allAttrMatchers,
        isHoverOrActive,
        isDisabled,
        isInteractivePseudo,
      };
    });

    for (const selMeta of block.parsedSelectors) {
      for (const cls of selMeta.subjectClasses) {
        let list = classBlocks.get(cls);
        if (!list) {
          list = [];
          classBlocks.set(cls, list);
        }
        list.push({ block, selMeta });
      }
    }
  }

  const result = { stripped, blocks, keyframesDecls, classBlocks };
  if (PARSED_CSS_CACHE.size > 200) PARSED_CSS_CACHE.clear();
  PARSED_CSS_CACHE.set(cssText, result);
  return result;
}

function loadImportedCssModules(program, contextFilename) {
  const modules = [];
  const identToModule = new Map();
  const classConsts = new Map();
  const baseDir = path.dirname(contextFilename || ".");

  for (const stmt of program.body ?? []) {
    if (stmt.type === "ImportDeclaration" && stmt.importKind !== "type") {
      const source = stmt.source?.value;
      if (typeof source === "string" && source.endsWith(".module.css")) {
        const cssPath = path.resolve(baseDir, source);
        if (existsSync(cssPath)) {
          const parsed = parseCssModule(readFileSync(cssPath, "utf8"));
          const mod = { importNode: stmt, cssPath, basename: path.basename(cssPath), parsed };
          modules.push(mod);
          for (const spec of stmt.specifiers ?? []) {
            if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
              identToModule.set(spec.local.name, mod);
            }
          }
        }
      }
      continue;
    }
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type === "VariableDeclaration" && decl.kind === "const") {
      for (const item of decl.declarations ?? []) {
        if (item.id?.type === "Identifier" && item.init) {
          classConsts.set(item.id.name, item.init);
        }
      }
    }
  }
  return { modules, identToModule, classConsts };
}

function resolveCssModuleMember(expr, identToModule) {
  const node = unwrapTs(expr);
  if (!node || node.type !== "MemberExpression" || node.object?.type !== "Identifier") return null;
  const mod = identToModule.get(node.object.name);
  if (!mod) return null;
  const className = !node.computed && node.property?.type === "Identifier"
    ? node.property.name
    : (node.computed ? staticString(node.property) : null);
  return className ? { mod, className } : null;
}

function resolveBranchFlag(testExpr, targetName) {
  const node = unwrapTs(testExpr);
  if (!node) return null;
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const inner = resolveBranchFlag(node.argument, targetName);
    return inner === null ? null : !inner;
  }
  if (node.type === "Identifier" && node.name === targetName) return true;
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === targetName
  ) {
    return true;
  }
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property?.type === "Identifier" &&
    node.property.name === targetName
  ) {
    return true;
  }
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === targetName
  ) {
    return true;
  }
  return null;
}

function evalConditionForBranches(testExpr, branches) {
  if (!branches) return null;
  for (const key of ["vertical", "docked"]) {
    const direct = resolveBranchFlag(testExpr, key);
    if (direct !== null) return direct ? branches[key] : !branches[key];
  }
  return null;
}

function extractCssModuleClassRefs(expr, identToModule, classConsts, branches = null, visited = new Set()) {
  const node = unwrapTs(expr);
  if (!node) return [];
  const direct = resolveCssModuleMember(node, identToModule);
  if (direct) return [direct];

  if (node.type === "Identifier") {
    if (visited.has(node.name)) return [];
    const init = classConsts?.get(node.name);
    if (!init) return [];
    visited.add(node.name);
    return extractCssModuleClassRefs(init, identToModule, classConsts, branches, visited);
  }
  if (node.type === "CallExpression") {
    const out = [];
    if (
      node.callee?.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property?.type === "Identifier" &&
      node.callee.property.name === "join"
    ) {
      out.push(...extractCssModuleClassRefs(node.callee.object, identToModule, classConsts, branches, visited));
    }
    for (const arg of node.arguments ?? []) {
      if (arg.type !== "SpreadElement") {
        out.push(...extractCssModuleClassRefs(arg, identToModule, classConsts, branches, visited));
      }
    }
    return out;
  }
  if (node.type === "ArrayExpression") {
    const out = [];
    for (const el of node.elements ?? []) {
      if (el && el.type !== "SpreadElement") {
        out.push(...extractCssModuleClassRefs(el, identToModule, classConsts, branches, visited));
      }
    }
    return out;
  }
  if (node.type === "TemplateLiteral") {
    const out = [];
    for (const sub of node.expressions ?? []) {
      out.push(...extractCssModuleClassRefs(sub, identToModule, classConsts, branches, visited));
    }
    return out;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return [
      ...extractCssModuleClassRefs(node.left, identToModule, classConsts, branches, visited),
      ...extractCssModuleClassRefs(node.right, identToModule, classConsts, branches, visited),
    ];
  }
  if (node.type === "LogicalExpression" && node.operator === "&&") {
    const cond = evalConditionForBranches(node.left, branches);
    if (cond === false) return [];
    return extractCssModuleClassRefs(node.right, identToModule, classConsts, branches, visited);
  }
  if (node.type === "ConditionalExpression") {
    const cond = evalConditionForBranches(node.test, branches);
    if (cond === true) return extractCssModuleClassRefs(node.consequent, identToModule, classConsts, branches, visited);
    if (cond === false) return extractCssModuleClassRefs(node.alternate, identToModule, classConsts, branches, visited);
    return [
      ...extractCssModuleClassRefs(node.consequent, identToModule, classConsts, branches, visited),
      ...extractCssModuleClassRefs(node.alternate, identToModule, classConsts, branches, visited),
    ];
  }
  return [];
}

function getElementClassExpr(opening) {
  const attr = getAttr(opening, "class");
  if (!attr?.value) return null;
  if (attr.value.type === "Literal") return attr.value;
  if (attr.value.type === "JSXExpressionContainer") return attr.value.expression;
  return null;
}

function getElementClassRefs(opening, identToModule, classConsts, branches = null) {
  const expr = getElementClassExpr(opening);
  return expr ? extractCssModuleClassRefs(expr, identToModule, classConsts, branches) : [];
}

function getStaticAttrValue(opening, name, aliases) {
  const attr = getAttr(opening, name);
  if (!attr) return { present: false, isStatic: false, value: null };
  if (!attr.value) return { present: true, isStatic: true, value: "true" };
  if (attr.value.type === "Literal") {
    return { present: true, isStatic: true, value: String(attr.value.value) };
  }
  if (attr.value.type === "JSXExpressionContainer") {
    const str = resolveStaticText(attr.value.expression, aliases);
    if (str !== null) return { present: true, isStatic: true, value: str };
    return { present: true, isStatic: false, value: null, expr: attr.value.expression };
  }
  return { present: true, isStatic: false, value: null };
}

function selectorMatchesOpening(selMeta, opening, aliases, branches = null) {
  const hasSpread = (opening?.attributes ?? []).some(a => a.type === "JSXSpreadAttribute");
  const matchers = branches ? selMeta.allAttrMatchers : selMeta.attrMatchers;
  for (const { name, value } of matchers) {
    if (branches && (name === "data-vertical" || name === "data-docked")) {
      const flag = name === "data-vertical" ? branches.vertical : branches.docked;
      const expected = value === null ? "true" : value;
      if (String(flag) !== expected) return false;
      continue;
    }
    if (hasSpread) continue;
    const attrInfo = getStaticAttrValue(opening, name, aliases);
    if (!attrInfo.present) return false;
    if (attrInfo.isStatic && value !== null && attrInfo.value !== value) return false;
  }
  return true;
}

function getMatchingClassEntries(opening, identToModule, classConsts, aliases, options = {}) {
  const { branches = null, includeHover = false, includeDisabled = false } = options;
  const refs = getElementClassRefs(opening, identToModule, classConsts, branches);
  const matched = [];
  for (const ref of refs) {
    const entries = ref.mod.parsed.classBlocks.get(ref.className) ?? [];
    for (const entry of entries) {
      const { selMeta } = entry;
      if (!includeHover && selMeta.isHoverOrActive) continue;
      if (!includeDisabled && selMeta.isDisabled) continue;
      if (!selectorMatchesOpening(selMeta, opening, aliases, branches)) continue;
      matched.push({ ...entry, ref });
    }
  }
  return matched;
}

function collectStaticStringTokens(expr, aliases, classConsts, visited = new Set()) {
  const node = unwrapTs(expr);
  if (!node) return [];
  const direct = resolveStaticText(node, aliases);
  if (direct !== null) return direct.trim().split(/\s+/).filter(Boolean);

  if (node.type === "Identifier") {
    if (visited.has(node.name)) return [];
    const init = classConsts?.get(node.name);
    if (!init) return [];
    visited.add(node.name);
    return collectStaticStringTokens(init, aliases, classConsts, visited);
  }
  if (node.type === "TemplateLiteral") {
    const tokens = [];
    for (const q of node.quasis ?? []) {
      const text = q.value?.cooked ?? q.value?.raw ?? "";
      tokens.push(...text.trim().split(/\s+/).filter(Boolean));
    }
    for (const sub of node.expressions ?? []) {
      tokens.push(...collectStaticStringTokens(sub, aliases, classConsts, visited));
    }
    return tokens;
  }
  if (node.type === "CallExpression") {
    const tokens = [];
    for (const arg of node.arguments ?? []) {
      if (arg.type !== "SpreadElement") {
        tokens.push(...collectStaticStringTokens(arg, aliases, classConsts, visited));
      }
    }
    return tokens;
  }
  if (node.type === "ArrayExpression") {
    const tokens = [];
    for (const el of node.elements ?? []) {
      if (el && el.type !== "SpreadElement") {
        tokens.push(...collectStaticStringTokens(el, aliases, classConsts, visited));
      }
    }
    return tokens;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return [
      ...collectStaticStringTokens(node.left, aliases, classConsts, visited),
      ...collectStaticStringTokens(node.right, aliases, classConsts, visited),
    ];
  }
  if (node.type === "ConditionalExpression") {
    const left = new Set(collectStaticStringTokens(node.consequent, aliases, classConsts, visited));
    const right = collectStaticStringTokens(node.alternate, aliases, classConsts, visited);
    return right.filter(t => left.has(t));
  }
  return [];
}

const rules = {
  "no-raw-colors": {
    meta: {
      type: "problem",
      docs: { description: "Disallow hardcoded hex/rgb/rgba/hsl color literals in UI files (DESIGN.md Strict Role-Pairing Rule)" },
      schema: [],
    },
    create(context) {
      const checkText = (node, text, allowShadowBlack = false) => {
        if (!text) return;
        if (hasDisallowedRawColor(text, allowShadowBlack)) {
          context.report({
            node,
            message:
              "Do not hardcode raw colors (#hex/rgb/rgba/hsl) in UI code; use semantic var(--color-*) tokens or color-mix(in srgb, var(--color-...) XX%, transparent).",
          });
        }
      };
      return {
        Program(program) {
          const { modules } = loadImportedCssModules(program, context.filename);
          for (const mod of modules) {
            const allDecls = [...mod.parsed.blocks.flatMap(b => b.declarations), ...mod.parsed.keyframesDecls];
            for (const decl of allDecls) {
              const allowShadowBlack = decl.prop === "box-shadow" || decl.prop === "text-shadow";
              if (hasDisallowedRawColor(decl.value, allowShadowBlack)) {
                context.report({
                  node: mod.importNode,
                  message: `${mod.basename} (${decl.prop}: ${decl.value}): do not hardcode raw colors (#hex/rgb/rgba/hsl) in CSS Modules; use semantic var(--color-*) tokens or color-mix(in srgb, var(--color-...) XX%, transparent).`,
                });
              }
            }
          }
        },
        Literal(node) {
          if (typeof node.value === "string") checkText(node, node.value, isInShadowProperty(node));
        },
        TemplateLiteral(node) {
          const joined = node.quasis.map(q => q.value.raw).join("");
          checkText(node, joined, isInShadowProperty(node));
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
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };

      const checkStringForUnknownRoles = (node, text, prefix = "") => {
        if (!text || !text.includes("--color-")) return;
        COLOR_VAR_RE.lastIndex = 0;
        let match;
        while ((match = COLOR_VAR_RE.exec(text)) !== null) {
          const role = match[1];
          if (!VALID_COLOR_ROLES.has(role)) {
            context.report({
              node,
              message: `${prefix}Unknown Material 3 color role "--color-${role}". Use one of the 31 roles from DESIGN.md / z-shell-theme.`,
            });
          }
        }
      };

      const checkPair = (node, bgRole, fgRole, prefix = "") => {
        if (!bgRole || !fgRole) return;
        const allowed = ROLE_PAIRS.get(bgRole);
        if (allowed && !allowed.has(fgRole)) {
          context.report({
            node,
            message: `${prefix}Invalid color role pair: foreground "--color-${fgRole}" on background "--color-${bgRole}". Expected one of: ${[...allowed].map(r => `--color-${r}`).join(", ")}.`,
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

      const extractLastBgRoleFromEntries = entries => {
        let lastRole = null;
        let hasAnyBgDecl = false;
        for (const entry of entries) {
          for (const decl of entry.block.declarations) {
            if (decl.prop === "background-color" || decl.prop === "background") {
              hasAnyBgDecl = true;
              lastRole = resolveColorRoleFromText(decl.value);
            }
          }
        }
        return { lastRole, hasAnyBgDecl };
      };

      const extractAttrConditionTest = attrExpr => {
        const node = unwrapTs(attrExpr);
        if (!node) return null;
        if (node.type === "ConditionalExpression") return node.test;
        if (node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||")) return node.left;
        return null;
      };

      const checkShellIconAgainstCssAncestor = (opening, fgNode) => {
        const entries = getMatchingClassEntries(opening, cssEnv.identToModule, cssEnv.classConsts, aliases);
        if (entries.length === 0) return false;
        const { hasAnyBgDecl } = extractLastBgRoleFromEntries(entries);
        if (!hasAnyBgDecl) return false;

        const roleCandidates = [];
        for (const entry of entries) {
          for (const decl of entry.block.declarations) {
            if (decl.prop === "background-color" || decl.prop === "background") {
              const role = resolveColorRoleFromText(decl.value);
              if (role) roleCandidates.push({ role, entry });
            }
          }
        }
        const uniqueRoles = [...new Set(roleCandidates.map(r => r.role))];
        if (uniqueRoles.length === 0) return true;

        const classExpr = unwrapTs(getElementClassExpr(opening));
        const hasConditionalClassOrAttr =
          entries.some(e => e.selMeta.attrMatchers.length > 0) ||
          (classExpr && classExpr.type !== "MemberExpression");

        if (uniqueRoles.length === 1 && !hasConditionalClassOrAttr) {
          visitValueBranches(fgNode, branch => {
            checkPair(branch, uniqueRoles[0], resolveColorRole(branch, aliases));
          });
          return true;
        }

        const staticFg = resolveColorRole(fgNode, aliases);
        if (staticFg) {
          for (const bgRole of uniqueRoles) {
            checkPair(fgNode, bgRole, staticFg);
          }
          return true;
        }

        const fgExpr = unwrapTs(fgNode);
        if (fgExpr?.type === "ConditionalExpression") {
          if (classExpr?.type === "ConditionalExpression" && sameAstCondition(classExpr.test, fgExpr.test, context.sourceCode)) {
            const conRefs = extractCssModuleClassRefs(classExpr.consequent, cssEnv.identToModule, cssEnv.classConsts);
            const altRefs = extractCssModuleClassRefs(classExpr.alternate, cssEnv.identToModule, cssEnv.classConsts);
            const conRoles = entries.filter(e => conRefs.some(r => r.className === e.ref.className));
            const altRoles = entries.filter(e => altRefs.some(r => r.className === e.ref.className));
            checkPair(fgExpr.consequent, extractLastBgRoleFromEntries(conRoles).lastRole, resolveColorRole(fgExpr.consequent, aliases));
            checkPair(fgExpr.alternate, extractLastBgRoleFromEntries(altRoles).lastRole, resolveColorRole(fgExpr.alternate, aliases));
            return true;
          }
          if (classExpr?.type === "CallExpression") {
            for (const arg of classExpr.arguments ?? []) {
              const argNode = unwrapTs(arg);
              if (argNode?.type === "LogicalExpression" && argNode.operator === "&&" && sameAstCondition(argNode.left, fgExpr.test, context.sourceCode)) {
                const condRefs = extractCssModuleClassRefs(argNode.right, cssEnv.identToModule, cssEnv.classConsts);
                const condSet = new Set(condRefs.map(r => r.className));
                const baseEntries = entries.filter(e => !condSet.has(e.ref.className));
                checkPair(fgExpr.consequent, extractLastBgRoleFromEntries(entries).lastRole, resolveColorRole(fgExpr.consequent, aliases));
                checkPair(fgExpr.alternate, extractLastBgRoleFromEntries(baseEntries).lastRole, resolveColorRole(fgExpr.alternate, aliases));
                return true;
              }
            }
          }
          for (const attr of opening.attributes ?? []) {
            if (attr.type !== "JSXAttribute" || attr.name?.type !== "JSXIdentifier" || !attr.name.name.startsWith("data-")) continue;
            const attrExpr = attr.value?.type === "JSXExpressionContainer" ? attr.value.expression : null;
            const attrTest = extractAttrConditionTest(attrExpr);
            if (attrTest && sameAstCondition(attrTest, fgExpr.test, context.sourceCode)) {
              const attrName = attr.name.name;
              const trueEntries = entries.filter(e => {
                const m = e.selMeta.attrMatchers.find(x => x.name === attrName);
                return !m || m.value === null || m.value === "true";
              });
              const falseEntries = entries.filter(e => !e.selMeta.attrMatchers.some(x => x.name === attrName));
              const conBg = extractLastBgRoleFromEntries(trueEntries).lastRole;
              const altBg = extractLastBgRoleFromEntries(falseEntries).lastRole;
              checkPair(fgExpr.consequent, conBg, resolveColorRole(fgExpr.consequent, aliases));
              checkPair(fgExpr.alternate, altBg, resolveColorRole(fgExpr.alternate, aliases));
              return true;
            }
          }
        }
        return true;
      };

      return {
        Program(program) {
          aliases = collectStringAliases(program);
          cssEnv = loadImportedCssModules(program, context.filename);
          for (const mod of cssEnv.modules) {
            checkStringForUnknownRoles(mod.importNode, mod.parsed.stripped, `${mod.basename}: `);
            for (const block of mod.parsed.blocks) {
              let bgRole = null;
              let fgRole = null;
              for (const decl of block.declarations) {
                if (decl.prop === "background-color" || decl.prop === "background") {
                  const role = resolveColorRoleFromText(decl.value);
                  if (role) bgRole = role;
                } else if (decl.prop === "color") {
                  const role = resolveColorRoleFromText(decl.value);
                  if (role) fgRole = role;
                }
              }
              if (bgRole && fgRole) {
                checkPair(mod.importNode, bgRole, fgRole, `${mod.basename} (${block.selectors.join(", ")}): `);
              }
            }
          }
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
              if (checkShellIconAgainstCssAncestor(cur.openingElement, fgNode)) {
                return;
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
      const checkCssModuleCalmSurface = mod => {
        const declsByClass = new Map();
        for (const [cls, entries] of mod.parsed.classBlocks) {
          const merged = new Map();
          for (const { block, selMeta } of entries) {
            if (selMeta.isHoverOrActive || selMeta.isDisabled) continue;
            if (selMeta.attrMatchers.length > 0) continue;
            for (const decl of block.declarations) merged.set(decl.prop, decl.value);
          }
          declsByClass.set(cls, merged);
        }

        for (const block of mod.parsed.blocks) {
          let bgPrimary = false;
          for (const decl of block.declarations) {
            if ((decl.prop === "background-color" || decl.prop === "background") && resolveColorRoleFromText(decl.value) === "primary") {
              bgPrimary = true;
            }
          }
          if (!bgPrimary) continue;
          if (block.selectors.some(sel => sel.includes("data-percent-fill"))) continue;

          const combined = new Map();
          for (const selMeta of block.parsedSelectors) {
            for (const cls of selMeta.subjectClasses) {
              const baseMap = declsByClass.get(cls);
              if (baseMap) {
                for (const [k, v] of baseMap) combined.set(k, v);
              }
            }
          }
          for (const decl of block.declarations) combined.set(decl.prop, decl.value);

          const isQsTile = block.selectors.some(sel => sel.includes("data-qs-tile") || /qsTile/i.test(sel));
          const height = parseCssPx(combined.get("height") ?? combined.get("min-height"));
          const width = parseCssPx(combined.get("width") ?? combined.get("min-width"));
          const flexGrowRaw = combined.get("flex-grow");
          const grows = flexGrowRaw !== undefined && Number(flexGrowRaw.trim()) > 0;
          const radius = combined.get("border-radius")?.trim() ?? null;
          const isCompactFab =
            !grows &&
            width !== null && height !== null && width <= 72 && height <= 56 &&
            (radius === "999px" || radius === "var(--radius-pill)");
          const isLargeContainer =
            isQsTile ||
            (!isCompactFab && ((height !== null && height >= 44) || (width !== null && width >= 44) || grows));
          if (isLargeContainer) {
            context.report({
              node: mod.importNode,
              message:
                `${mod.basename} (${block.selectors.join(", ")}): Calm Active Surface Rule: do not fill large active containers with solid var(--color-primary); use var(--color-primary-container) + var(--color-on-primary-container).`,
            });
          }
        }
      };

      return {
        Program(program) {
          aliases = collectStringAliases(program);
          const { modules } = loadImportedCssModules(program, context.filename);
          for (const mod of modules) checkCssModuleCalmSurface(mod);
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
        Program(program) {
          const { modules } = loadImportedCssModules(program, context.filename);
          for (const mod of modules) {
            for (const block of mod.parsed.blocks) {
              if (block.isRootRule) continue;
              for (const decl of block.declarations) {
                if (decl.prop !== "font-family") continue;
                if (!FONT_TOKEN_RE.test(decl.value.trim())) {
                  context.report({
                    node: mod.importNode,
                    message: `${mod.basename} (${block.selectors.join(", ")}): do not hardcode font-family "${decl.value}". Use var(--font-sans), var(--font-mono), or inherit from :root.`,
                  });
                }
              }
            }
          }
        },
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
      const RADIUS_CSS_PROPS = new Set([
        "border-radius",
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-left-radius",
        "border-bottom-right-radius",
      ]);
      const RADIUS_JS_PROPS = new Set([
        "borderRadius",
        "border-radius",
        "borderTopLeftRadius",
        "borderTopRightRadius",
        "borderBottomLeftRadius",
        "borderBottomRightRadius",
      ]);
      return {
        Program(program) {
          const { modules } = loadImportedCssModules(program, context.filename);
          for (const mod of modules) {
            for (const block of mod.parsed.blocks) {
              for (const decl of block.declarations) {
                if (!RADIUS_CSS_PROPS.has(decl.prop)) continue;
                if (!checkRadiusValue(decl.value)) {
                  context.report({
                    node: mod.importNode,
                    message: `${mod.basename} (${block.selectors.join(", ")}): off-scale ${decl.prop} "${decl.value}". Use DESIGN.md shape tokens: 6px (xs), 8px (sm), 10px (md), 12px (concentric dock/pill), 14px (tile), 16px (card), 22px (panel), 999px (pill), or var(--radius-*).`,
                  });
                }
              }
            }
          }
        },
        Property(node) {
          const key = propertyName(node);
          if (!RADIUS_JS_PROPS.has(key)) return;
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
        Program(program) {
          const { modules } = loadImportedCssModules(program, context.filename);
          for (const mod of modules) {
            for (const block of mod.parsed.blocks) {
              for (const decl of block.declarations) {
                if (decl.prop !== "outline" && decl.prop !== "outline-width") continue;
                if (OUTLINE_NONE_RE.test(decl.value.trim())) {
                  context.report({
                    node: mod.importNode,
                    message: `${mod.basename} (${block.selectors.join(", ")}): do not strip focus rings with ${decl.prop}: ${decl.value} (WCAG 2.2 SC 2.4.7 / 2.4.13).`,
                  });
                }
              }
            }
          }
        },
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
      if (basename === "shapes.ts" || basename === "tabler-icons.generated.ts") return {};
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
      docs: { description: "Enforce The Tabler-First System UI Icon Rule: 24x24 viewBox for system UI glyphs and centralized ShellIcon usage" },
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
          if (basename !== "icons.tsx" && basename !== "tabler-icons.generated.ts") return;
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
              message: `System UI Icon Rule: icon "${iconName ?? "unknown"}" must use 24x24 grid (viewBox="0 0 24 24"), got "${value}".`,
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
                message: `System UI Icon Rule: <vector> viewBox must be "0 0 24 24" (24x24 grid) or "0 0 64 64" (expressive shape), got "${attrValue}".`,
              });
            }
            if (isShellSurfaceOrPanel && attr.name.name === "d" && attrValue !== null) {
              context.report({
                node: attr.value,
                message:
                  "System UI Icon Rule: do not inline ad-hoc SVG path literals in panels/surfaces; register Tabler icons in icons.tsx via icons:sync or analytical shapes in shapes.ts.",
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
      let aliases = new Map();
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };
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
        Program(program) {
          aliases = collectStringAliases(program);
          cssEnv = loadImportedCssModules(program, context.filename);
        },
        JSXElement(node) {
          const opening = node.openingElement;
          if (opening?.name?.type !== "JSXIdentifier" || opening.name.name !== "text") return;
          const styleAttr = getAttr(opening, "style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? unwrapTs(styleAttr.value.expression) : null;
          const styleMap = styleExpr?.type === "ObjectExpression" ? getStyleProps(styleExpr).map : null;

          let cssFontFamily = null;
          let cssFvn = null;
          for (const entry of getMatchingClassEntries(opening, cssEnv.identToModule, cssEnv.classConsts, aliases)) {
            for (const decl of entry.block.declarations) {
              if (decl.prop === "font-family") cssFontFamily = decl.value.trim();
              else if (decl.prop === "font-variant-numeric") cssFvn = decl.value.trim();
            }
          }

          const inlineFontFamily = styleMap
            ? resolveStaticText(styleMap.get("fontFamily") ?? styleMap.get("font-family"), aliases)?.trim() ?? null
            : null;
          const inlineFvn = styleMap
            ? resolveStaticText(styleMap.get("fontVariantNumeric") ?? styleMap.get("font-variant-numeric"), aliases)?.trim() ?? null
            : null;

          const fontFamily = inlineFontFamily ?? cssFontFamily;
          if (fontFamily !== "var(--font-mono)") return;
          const fvn = inlineFvn ?? cssFvn;
          if (fvn === "tabular-nums") return;

          const isTabularSlot = Boolean(getAttr(opening, "data-tabular"));
          const childrenText = (node.children ?? []).map(child => context.sourceCode?.getText?.(child) ?? "").join(" ");
          if (isTabularSlot || NUMERIC_READOUT_RE.test(childrenText)) {
            context.report({
              node: styleAttr ?? getAttr(opening, "class") ?? opening,
              message: "Tabular Readout Rule: numeric readout slots using var(--font-mono) must declare fontVariantNumeric: \"tabular-nums\".",
            });
          }
        },
        ObjectExpression(node) {
          if (enclosingTextElement(node)) return;
          const { map } = getStyleProps(node);
          const fontFamily = staticString(map.get("fontFamily") ?? map.get("font-family"));
          if (fontFamily !== "var(--font-mono)") return;
          const fvn = staticString(map.get("fontVariantNumeric") ?? map.get("font-variant-numeric"));
          if (fvn === "tabular-nums") return;

          if (isEnclosingJsxElementWithAttr(node, "data-tabular")) {
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
      let aliases = new Map();
      let cssEnv = { classConsts: new Map() };
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
        Program(program) {
          aliases = collectStringAliases(program);
          cssEnv = loadImportedCssModules(program, context.filename);
        },
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
          const classExpr = getElementClassExpr(node);
          const classTokens = classExpr ? collectStaticStringTokens(classExpr, aliases, cssEnv.classConsts) : [];
          const hasCompositeClass = classTokens.includes("shell-composite-field");
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
      const GEOMETRIC_TRANSFORM_VALUE_RE = /\b(?:translate|scale|rotate|skew|matrix)/i;
      const SUBJECT_INTERACTIVE_PSEUDO_RE = /:(?:hover|active)(?::[a-z-]+)*\s*$/i;
      let aliases = new Map();
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };

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

      const checkCssModuleTransforms = mod => {
        for (const block of mod.parsed.blocks) {
          const hasGeomTransform = block.declarations.some(
            decl => decl.prop === "transform" && GEOMETRIC_TRANSFORM_VALUE_RE.test(decl.value),
          );
          if (!hasGeomTransform) continue;
          for (const selMeta of block.parsedSelectors) {
            if (selMeta.isHoverOrActive) {
              context.report({
                node: mod.importNode,
                message: `${mod.basename}: Hover Hit-Target Stability Rule: do not apply geometric transform directly on ":hover/:active" subject selector "${selMeta.selector}". Keep the interactive hit target stationary and transform a pointer-events: none inner child (e.g. "parent:hover > [data-dock-visual]") to prevent hover oscillation.`,
              });
            }
          }
        }
      };

      return {
        Program(program) {
          aliases = collectStringAliases(program);
          cssEnv = loadImportedCssModules(program, context.filename);
          for (const mod of cssEnv.modules) checkCssModuleTransforms(mod);
        },
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
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? unwrapTs(styleAttr.value.expression) : null;
          const styleMap = styleExpr?.type === "ObjectExpression" ? getStyleProps(styleExpr).map : null;
          const classRefs = getElementClassRefs(node, cssEnv.identToModule, cssEnv.classConsts);
          const matchingEntries = classRefs.length > 0
            ? getMatchingClassEntries(node, cssEnv.identToModule, cssEnv.classConsts, aliases, { includeHover: true })
            : [];

          let cssPe = null;
          for (const entry of matchingEntries) {
            if (entry.selMeta.isHoverOrActive) continue;
            for (const decl of entry.block.declarations) {
              if (decl.prop === "pointer-events") cssPe = decl.value.trim();
            }
          }

          if (findAttr("data-dock-visual") && (styleMap || classRefs.length > 0)) {
            const inlinePe = styleMap ? staticString(styleMap.get("pointerEvents") ?? styleMap.get("pointer-events")) : null;
            const pe = inlinePe ?? cssPe;
            if (pe !== "none") {
              context.report({
                node,
                message: "Hover Hit-Target Stability Rule: transformed visual child [data-dock-visual] must set pointerEvents: \"none\" so it never alters hit-testing.",
              });
            }
          }

          if (findAttr("data-press-visual") && (styleMap || classRefs.length > 0)) {
            const peNode = styleMap ? (styleMap.get("pointerEvents") ?? styleMap.get("pointer-events")) : null;
            const inlinePe = peNode ? staticString(peNode) : null;
            const pe = inlinePe ?? cssPe;
            if ((peNode || cssPe !== null) && pe !== "none") {
              context.report({
                node,
                message: "Hover Hit-Target Stability Rule: [data-press-visual] must preserve pointerEvents: \"none\" so press compression never shifts hit-testing.",
              });
            }
          }

          if (node.name?.type === "JSXIdentifier" && node.name.name === "Button" && (styleMap || classRefs.length > 0)) {
            const disabledAttr = findAttr("disabled");
            const staticallyDisabled =
              disabledAttr &&
              (disabledAttr.value === null ||
                (disabledAttr.value?.type === "JSXExpressionContainer" &&
                  disabledAttr.value.expression?.type === "Literal" &&
                  disabledAttr.value.expression.value === true));
            if (!staticallyDisabled) {
              const cursor = styleMap ? staticString(styleMap.get("cursor")) : null;
              if (cursor === "default" || cursor === "auto") {
                context.report({
                  node,
                  message: `Universal Pointer Affordance Rule: do not override cursor to "${cursor}" on an enabled <Button>; interactive controls must preserve cursor: pointer.`,
                });
              }
              for (const entry of matchingEntries) {
                for (const decl of entry.block.declarations) {
                  if (decl.prop === "cursor") {
                    const c = decl.value.trim();
                    if (c === "default" || c === "auto") {
                      context.report({
                        node,
                        message: `Universal Pointer Affordance Rule: ${entry.ref.mod.basename} (${entry.selMeta.selector}) must not override cursor to "${c}" on an enabled <Button>; interactive controls must preserve cursor: pointer.`,
                      });
                    }
                  }
                }
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
      let cssModules = [];
      return {
        Program(program) {
          cssModules = loadImportedCssModules(program, context.filename).modules;
        },
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
          const msg = isToplevelWindow
            ? "Flush Surface Shadow Rule: do not apply CSS boxShadow on WindowSurface (xdg_toplevel prefers compositor-owned shadows)."
            : "Flush Surface Shadow Rule: do not apply CSS boxShadow on flush PopupSurface containers without geometryInsets bleed (shadow leaks outside borderRadius and clips at surface bounds).";
          for (const node of shadowNodes) {
            context.report({ node, message: msg });
          }
          for (const mod of cssModules) {
            for (const block of mod.parsed.blocks) {
              for (const decl of block.declarations) {
                if (decl.prop !== "box-shadow") continue;
                const trimmed = decl.value.trim().toLowerCase();
                if (trimmed === "none" || /^inset\b/.test(trimmed)) continue;
                context.report({
                  node: mod.importNode,
                  message: `${mod.basename} (${block.selectors.join(", ")}): ${msg}`,
                });
              }
            }
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

      const checkCssModuleMotion = mod => {
        for (const block of mod.parsed.blocks) {
          if (block.isRootRule) continue;
          for (const decl of block.declarations) {
            if (decl.prop === "transition-timing-function") {
              for (const item of splitTopLevel(decl.value, ch => ch === ",")) {
                checkTimingValue(mod.importNode, item);
              }
            } else if (decl.prop === "transition-property" || decl.prop === "transition") {
              if (/\boutline-width\b/i.test(decl.value)) {
                context.report({
                  node: mod.importNode,
                  message: `${mod.basename} (${block.selectors.join(", ")}): M3 Motion Rule: never animate outline-width (docs/design/motion.md §5.8); fade focus ring color/opacity instead.`,
                });
              }
              if (decl.prop === "transition") {
                for (const item of splitTopLevel(decl.value, ch => ch === ",")) {
                  const bezier = /cubic-bezier\([^)]+\)/i.exec(item);
                  if (bezier) checkTimingValue(mod.importNode, bezier[0]);
                  const keyword = /(?:^|\s)(ease(?:-in|-out|-in-out)?|step-(?:start|end))(?:\s|$)/i.exec(item);
                  if (keyword) checkTimingValue(mod.importNode, keyword[1]);
                }
              }
            }
          }
        }
      };

      return {
        Program(program) {
          const { modules } = loadImportedCssModules(program, context.filename);
          for (const mod of modules) checkCssModuleMotion(mod);
        },
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
      const HIT_DIM_JS_PROPS = new Set(["width", "height", "minWidth", "minHeight", "min-width", "min-height"]);
      const HIT_DIM_CSS_PROPS = new Set(["width", "height", "min-width", "min-height"]);
      let aliases = new Map();
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };
      const checkDim = (propNode, propName, rawVal, prefix = "") => {
        if (typeof rawVal !== "string") return;
        const match = PX_RE.exec(rawVal.trim());
        if (!match) return;
        const px = Number(match[1]);
        if (px > 0 && px < 24) {
          context.report({
            node: propNode,
            message: `${prefix}WCAG 2.2 SC 2.5.8 Hit-Target Rule: interactive control declares ${propName}: "${rawVal}" (< 24px). Keep interactive hit targets >= 24x24px.`,
          });
        }
      };
      const inspectStyleExpr = expr => {
        if (!expr) return;
        const node = unwrapTs(expr);
        if (node?.type === "ObjectExpression") {
          for (const prop of node.properties) {
            if (prop.type !== "Property") continue;
            const key = propertyName(prop);
            if (!HIT_DIM_JS_PROPS.has(key)) continue;
            if (prop.value?.type === "ConditionalExpression") {
              checkDim(prop.value.consequent, key, staticString(prop.value.consequent));
              checkDim(prop.value.alternate, key, staticString(prop.value.alternate));
            } else {
              checkDim(prop.value, key, staticString(prop.value));
            }
          }
        } else if (node?.type === "ConditionalExpression") {
          inspectStyleExpr(node.consequent);
          inspectStyleExpr(node.alternate);
        }
      };
      return {
        Program(program) {
          aliases = collectStringAliases(program);
          cssEnv = loadImportedCssModules(program, context.filename);
        },
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier" || (node.name.name !== "Button" && node.name.name !== "control")) return;
          for (const attr of node.attributes ?? []) {
            if (attr.type !== "JSXAttribute" || attr.name?.type !== "JSXIdentifier" || attr.name.name !== "style") continue;
            if (attr.value?.type === "JSXExpressionContainer") {
              inspectStyleExpr(attr.value.expression);
            }
          }
          const classAttr = getAttr(node, "class");
          if (classAttr) {
            for (const entry of getMatchingClassEntries(node, cssEnv.identToModule, cssEnv.classConsts, aliases)) {
              for (const decl of entry.block.declarations) {
                if (HIT_DIM_CSS_PROPS.has(decl.prop)) {
                  checkDim(classAttr, decl.prop, decl.value, `${entry.ref.mod.basename} (${entry.selMeta.selector}): `);
                }
              }
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
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };
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
      const isPillRadius = val => val === "999px" || val === "var(--radius-pill)";
      return {
        Program(program) {
          aliases = collectStringAliases(program);
          cssEnv = loadImportedCssModules(program, context.filename);
        },
        JSXElement(node) {
          const opening = node.openingElement;
          if (opening?.name?.type !== "JSXIdentifier" || opening.name.name !== "Button") return;
          if (hasAttr(opening, "data-switch-root") || hasAttr(opening, "data-bar-pill")) return;
          if (!hasTextContent(node)) return;

          const styleAttr = getAttr(opening, "style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? unwrapTs(styleAttr.value.expression) : null;
          const styleMap = styleExpr?.type === "ObjectExpression" ? getStyleProps(styleExpr).map : null;
          const classAttr = getAttr(opening, "class");
          const classEntries = classAttr
            ? getMatchingClassEntries(opening, cssEnv.identToModule, cssEnv.classConsts, aliases)
            : [];

          let cssWidth = null;
          let cssHeight = null;
          const cssPillHits = [];
          for (const entry of classEntries) {
            for (const decl of entry.block.declarations) {
              if (decl.prop === "width") cssWidth = parseCssPx(decl.value);
              else if (decl.prop === "height") cssHeight = parseCssPx(decl.value);
              else if (decl.prop === "border-radius" && isPillRadius(decl.value.trim())) {
                cssPillHits.push(`${entry.ref.mod.basename} (${entry.selMeta.selector})`);
              }
            }
          }

          const inlineWidth = styleMap ? parsePx(styleMap.get("width"), aliases) : null;
          const inlineHeight = styleMap ? parsePx(styleMap.get("height"), aliases) : null;
          const width = inlineWidth ?? cssWidth;
          const height = inlineHeight ?? cssHeight;
          // Square circular icon/swatch/avatar badges (e.g. 24x24, 36x36) are allowed.
          if (width !== null && height !== null && width === height) return;

          const radiusNode = styleMap ? (styleMap.get("borderRadius") ?? styleMap.get("border-radius")) : null;
          if (radiusNode) {
            visitValueBranches(radiusNode, branch => {
              const val = resolveStaticText(branch, aliases)?.trim();
              if (isPillRadius(val)) {
                context.report({
                  node: branch,
                  message:
                    "Desktop Action Button Rule: do not use pill borderRadius (999px) on rectangular text action buttons; use M3Button (10px md / 8px sm) or M3FilterChip (8px).",
                });
              }
            });
          } else if (cssPillHits.length > 0 && classAttr) {
            context.report({
              node: classAttr,
              message:
                `${cssPillHits[0]}: Desktop Action Button Rule: do not use pill border-radius (999px) on rectangular text action buttons; use M3Button (10px md / 8px sm) or M3FilterChip (8px).`,
            });
          }
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
      const checkShadowValue = (node, val, prefix = "") => {
        if (!val) return;
        const trimmed = val.trim();
        if (trimmed === "none" || /^var\(--shadow-level-[123]\)$/.test(trimmed)) return;
        if (RAW_COLOR_TOKEN_RE.test(trimmed)) {
          RAW_COLOR_TOKEN_RE.lastIndex = 0;
          context.report({
            node,
            message:
              `${prefix}Semantic Elevation Rule: do not hardcode rgba()/hex boxShadow values (breaks Light Mode); use var(--shadow-level-1), var(--shadow-level-2), or var(--shadow-level-3).`,
          });
        }
      };
      return {
        Program(program) {
          const { modules } = loadImportedCssModules(program, context.filename);
          for (const mod of modules) {
            for (const block of mod.parsed.blocks) {
              for (const decl of block.declarations) {
                if (decl.prop === "box-shadow") {
                  checkShadowValue(mod.importNode, decl.value, `${mod.basename} (${block.selectors.join(", ")}): `);
                }
              }
            }
          }
        },
        Property(node) {
          const key = propertyName(node);
          if (key !== "boxShadow" && key !== "box-shadow") return;
          visitValueBranches(node.value, branch => {
            checkShadowValue(branch, staticString(branch));
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
      const checkCssModuleSurface = mod => {
        const classHasBlur = new Set();
        for (const [cls, entries] of mod.parsed.classBlocks) {
          for (const { block, selMeta } of entries) {
            if (selMeta.isHoverOrActive || selMeta.isDisabled) continue;
            for (const decl of block.declarations) {
              if (decl.prop === "backdrop-filter" && decl.value.trim().toLowerCase() !== "none") {
                classHasBlur.add(cls);
              }
            }
          }
        }
        for (const block of mod.parsed.blocks) {
          let blockHasBlur = false;
          for (const decl of block.declarations) {
            if (decl.prop === "backdrop-filter" && decl.value.trim().toLowerCase() !== "none") {
              blockHasBlur = true;
              if (isAlwaysSolidSurface) {
                context.report({
                  node: mod.importNode,
                  message: `${mod.basename} (${block.selectors.join(", ")}): 4-Tier Material Ladder Rule: Settings Window (Level 3) must remain 100% solid opaque M3 without backdrop-filter.`,
                });
              }
            }
          }
          const subjectHasBlur = blockHasBlur || block.parsedSelectors.some(s => s.subjectClasses.some(c => classHasBlur.has(c)));
          for (const decl of block.declarations) {
            if (decl.prop !== "background-color" && decl.prop !== "background") continue;
            if (subjectHasBlur && !isAlwaysSolidSurface) continue;
            const match = TRANSLUCENT_SURFACE_RE.exec(decl.value);
            if (match && Number(match[1]) < 95) {
              context.report({
                node: mod.importNode,
                message: isAlwaysSolidSurface
                  ? `${mod.basename} (${block.selectors.join(", ")}): 4-Tier Material Ladder Rule: Settings Window (Level 3) must remain 100% solid opaque var(--color-surface*).`
                  : `${mod.basename} (${block.selectors.join(", ")}): Wayland Graceful Solid Fallback Rule: do not paint translucent glass surfaces (Levels 1A/1B/2) without compositor backdrop blur (ext_background_effect_v1); use opaque var(--color-surface-container*).`,
              });
            }
          }
        }
      };

      return {
        Program(program) {
          const { modules } = loadImportedCssModules(program, context.filename);
          for (const mod of modules) checkCssModuleSurface(mod);
        },
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
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };
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
          cssEnv = loadImportedCssModules(program, context.filename);
          if (basename === "DockSurface.tsx") {
            for (const mod of cssEnv.modules) {
              for (const block of mod.parsed.blocks) {
                const isCapsuleBlock = block.parsedSelectors.some(s =>
                  s.subjectClasses.some(c => /^capsule$/i.test(c) || /dockCapsule/i.test(c)),
                );
                if (!isCapsuleBlock) continue;
                for (const decl of block.declarations) {
                  if (decl.prop !== "border-radius") continue;
                  const val = decl.value.trim();
                  if (val !== "22px" && val !== "var(--radius-panel)") {
                    context.report({
                      node: mod.importNode,
                      message: `${mod.basename} (${block.selectors.join(", ")}): Concentric Floating Dock Rule: Dock capsule must use R=22px (22px or var(--radius-panel)) to stay concentric with 10-12px icons at 10px inset, got "${val}".`,
                    });
                  }
                }
              }
            }
          }
        },
        VariableDeclarator(node) {
          if (basename !== "DockSurface.tsx" || node.id?.type !== "Identifier" || node.id.name !== "capsule") return;
          const init = unwrapTs(node.init);
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
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? unwrapTs(styleAttr.value.expression) : null;
          const styleMap = styleExpr?.type === "ObjectExpression" ? getStyleProps(styleExpr).map : null;
          const classAttr = getAttr(node, "class");
          const classEntries = classAttr
            ? getMatchingClassEntries(node, cssEnv.identToModule, cssEnv.classConsts, aliases)
            : [];
          if (!styleMap && classEntries.length === 0) return;

          const radiusNode = styleMap ? (styleMap.get("borderRadius") ?? styleMap.get("border-radius")) : null;
          let cssRadius = null;
          for (const entry of classEntries) {
            for (const decl of entry.block.declarations) {
              if (decl.prop === "border-radius") cssRadius = decl.value.trim();
            }
          }

          if (basename === "DockSurface.tsx") {
            const testId = getStringAttr(node, "testId");
            const isDockVisual = Boolean(getAttr(node, "data-dock-visual"));
            if (testId === "dock-launcher" || isDockVisual) {
              const px = radiusNode ? parsePx(radiusNode, aliases) : (cssRadius ? parseCssPx(cssRadius) : null);
              if (px !== null && (px < 10 || px > 12)) {
                context.report({
                  node: radiusNode ?? classAttr ?? node,
                  message: `Concentric Floating Dock Rule: Dock inner tiles must use 10px-12px radius (22px outer - 10px inset = 12px ±2px), got "${px}px".`,
                });
              }
            }
          }

          if (basename === "QuickSettingsPanel.tsx") {
            const isTileIconWell = Boolean(getAttr(node, "data-qs-tile-icon"));
            if (!isTileIconWell) return;
            const val = radiusNode ? resolveStaticText(radiusNode, aliases)?.trim() : cssRadius;
            const px = radiusNode ? parsePx(radiusNode, aliases) : (cssRadius ? parseCssPx(cssRadius) : null);
            const isValid = val === "999px" || val === "var(--radius-pill)" || (px !== null && px <= 6);
            if (!isValid) {
              context.report({
                node: radiusNode ?? classAttr ?? node,
                message:
                  "Concentric Quick Tile Rule: icon well inside 50px (R=14px) QuickTile must use circular borderRadius (999px / var(--radius-pill)) or concentric <=6px radius.",
              });
            }
          }

          if (basename === "StatusBar.tsx") {
            const testId = getStringAttr(node, "testId");
            if (testId === "bar-notifications-badge" || testId === "bar-ime") {
              const inlineText = styleExpr ? (context.sourceCode?.getText?.(styleExpr) ?? "") : "";
              const classText = classAttr ? (context.sourceCode?.getText?.(classAttr) ?? "") : "";
              const hasInlineVerticalMaxWidth = inlineText.includes("vertical") && inlineText.includes("maxWidth");
              const hasCssVerticalMaxWidth = classEntries.some(entry =>
                (/vertical/i.test(entry.selMeta.selector) || /vertical/i.test(entry.ref.className)) &&
                entry.block.declarations.some(d => d.prop === "max-width" || d.prop === "max-inline-size"),
              );
              if (!hasInlineVerticalMaxWidth && !hasCssVerticalMaxWidth) {
                context.report({
                  node: styleExpr ?? classAttr ?? node,
                  message: `Concentric Bar Pill Rule: nested pill "${testId}" must bound vertical maxWidth/padding so it never overflows or overlaps the 34px/40px vertical bar capsule border.`,
                });
              }

              const bgNode = styleMap ? (styleMap.get("backgroundColor") ?? styleMap.get("background-color")) : null;
              if (bgNode) {
                const staticBgRole = resolveColorRole(bgNode, aliases);
                if (staticBgRole === "primary-container") {
                  context.report({
                    node: bgNode,
                    message: `Concentric Bar Pill Rule: nested pill "${testId}" must separate its fill from an active primary-container parent capsule instead of painting flat primary-container on primary-container.`,
                  });
                }
              } else {
                const cssBgs = [];
                let hasActiveCssBgOverride = false;
                for (const entry of classEntries) {
                  for (const decl of entry.block.declarations) {
                    if (decl.prop === "background-color" || decl.prop === "background") {
                      cssBgs.push({ value: decl.value.trim(), entry });
                      if (/active/i.test(entry.selMeta.selector) || /active/i.test(entry.ref.className)) {
                        hasActiveCssBgOverride = true;
                      }
                    }
                  }
                }
                const onlyFlatPrimaryContainer =
                  cssBgs.length > 0 &&
                  !hasActiveCssBgOverride &&
                  cssBgs.every(item => resolveColorRoleFromText(item.value) === "primary-container");
                const hasNeitherInlineNorCssBg = cssBgs.length === 0 && !inlineText.includes("onActiveContainer") && !classText.includes("Active");
                if (onlyFlatPrimaryContainer || hasNeitherInlineNorCssBg) {
                  context.report({
                    node: styleExpr ?? classAttr ?? node,
                    message: `Concentric Bar Pill Rule: nested pill "${testId}" must separate its fill from an active primary-container parent capsule instead of painting flat primary-container on primary-container.`,
                  });
                }
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
      let aliases = new Map();
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };

      const exprDefinesRadius = expr => {
        if (!expr) return false;
        const unwrapped = unwrapTs(expr);
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

      const classHasBorderRadius = (mod, className, opening) => {
        const entries = mod.parsed.classBlocks.get(className) ?? [];
        return entries.some(({ block, selMeta }) => {
          if (selMeta.isHoverOrActive || selMeta.isDisabled) return false;
          if (!selectorMatchesOpening(selMeta, opening, aliases)) return false;
          return block.declarations.some(d => d.prop === "border-radius");
        });
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
          aliases = collectStringAliases(program);
          cssEnv = loadImportedCssModules(program, context.filename);
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
          if (
            findAttr("data-switch-root") ||
            findAttr("data-dock-item") ||
            findAttr("data-bar-segment") ||
            checkRoleExempt(findAttr("role"))
          ) {
            return;
          }
          const styleAttr = findAttr("style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          const hasInlineRadius = Boolean(styleExpr && exprDefinesRadius(styleExpr));
          const classAttr = findAttr("class");
          const classRefs = classAttr ? getElementClassRefs(node, cssEnv.identToModule, cssEnv.classConsts) : [];

          if (classRefs.length > 0) {
            const hasCssRadius = classRefs.some(ref => classHasBorderRadius(ref.mod, ref.className, node));
            if (!hasCssRadius && !hasInlineRadius) {
              context.report({
                node: styleAttr ?? classAttr,
                message: `Interactive Hover Radius Rule: <${tag}> using CSS Module classes must declare border-radius (in CSS or inline style) so universal M3 :hover/:active state layers never paint sharp-cornered rectangles.`,
              });
            }
            return;
          }

          if (classAttr || !styleExpr) return;
          if (!hasInlineRadius) {
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
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };
      const styleMeta = new Map();

      const emptyMeta = () => ({
        hasFlex: false,
        hasAlignCenter: false,
        hasJustifyCenter: false,
        isColumn: false,
        hasSurface: false,
        hasLineHeight: false,
      });

      const applyCssDeclToMeta = (meta, prop, strVal) => {
        const val = strVal?.trim();
        if (prop === "display" && val === "flex") meta.hasFlex = true;
        if ((prop === "alignItems" || prop === "align-items") && val === "center") meta.hasAlignCenter = true;
        if ((prop === "justifyContent" || prop === "justify-content") && val === "center") meta.hasJustifyCenter = true;
        if ((prop === "flexDirection" || prop === "flex-direction") && val === "column") meta.isColumn = true;
        if (prop === "lineHeight" || prop === "line-height") meta.hasLineHeight = true;
        if (
          prop === "borderRadius" ||
          prop === "border-radius" ||
          prop === "backgroundColor" ||
          prop === "background-color" ||
          prop === "border"
        ) {
          meta.hasSurface = true;
        }
      };

      const mergeMeta = (target, src) => {
        target.hasFlex ||= src.hasFlex;
        target.hasAlignCenter ||= src.hasAlignCenter;
        target.hasJustifyCenter ||= src.hasJustifyCenter;
        target.isColumn ||= src.isColumn;
        target.hasSurface ||= src.hasSurface;
        target.hasLineHeight ||= src.hasLineHeight;
      };

      const analyzeStyleExpr = expr => {
        const result = emptyMeta();
        const node = unwrapTs(expr);
        if (!node) return result;
        if (node.type === "Identifier") {
          return styleMeta.get(node.name) ?? result;
        }
        if (node.type !== "ObjectExpression") return result;

        for (const prop of node.properties ?? []) {
          if (prop.type === "SpreadElement") {
            const arg = unwrapTs(prop.argument);
            const spread =
              arg?.type === "Identifier"
                ? styleMeta.get(arg.name)
                : arg?.type === "ObjectExpression"
                  ? analyzeStyleExpr(arg)
                  : null;
            if (spread) mergeMeta(result, spread);
            continue;
          }
          const key = propertyName(prop);
          if (!key) continue;
          applyCssDeclToMeta(result, key, resolveStaticText(prop.value, aliases));
        }
        return result;
      };

      const analyzeOpeningCssMeta = opening => {
        const result = emptyMeta();
        for (const entry of getMatchingClassEntries(opening, cssEnv.identToModule, cssEnv.classConsts, aliases)) {
          for (const decl of entry.block.declarations) {
            applyCssDeclToMeta(result, decl.prop, decl.value);
          }
        }
        return result;
      };

      const recordStyleConst = item => {
        if (item.id?.type !== "Identifier" || !item.init) return;
        const init = unwrapTs(item.init);
        if (init?.type === "ObjectExpression") {
          styleMeta.set(item.id.name, analyzeStyleExpr(init));
        }
      };

      const LEAF_BADGE_TAGS = new Set(["text", "ShellIcon", "vector", "Image"]);

      return {
        Program(program) {
          aliases = collectStringAliases(program);
          cssEnv = loadImportedCssModules(program, context.filename);
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
          const styleAttr = getAttr(opening, "style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          const classAttr = getAttr(opening, "class");
          const hasCssRefs = classAttr ? getElementClassRefs(opening, cssEnv.identToModule, cssEnv.classConsts).length > 0 : false;
          if (!styleExpr && !hasCssRefs) return;

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

          const meta = emptyMeta();
          if (hasCssRefs) mergeMeta(meta, analyzeOpeningCssMeta(opening));
          if (styleExpr) mergeMeta(meta, analyzeStyleExpr(styleExpr));
          if (!meta.hasSurface) return;

          const hasFlex = tag === "row" || meta.hasFlex;
          const centeredVertically = meta.isColumn ? meta.hasJustifyCenter : meta.hasAlignCenter;
          if (!hasFlex || !centeredVertically) {
            context.report({
              node: styleAttr ?? classAttr ?? opening,
              message: `Centered Text Badge Rule: styled <${tag}> badge wrapping <text> must use flex vertical centering (display: "flex", ${meta.isColumn ? 'justifyContent: "center"' : 'alignItems: "center"'}) so keycaps and pills never drift off-center.`,
            });
          }

          for (const { child } of textChildren) {
            const childOpening = child.openingElement;
            const textStyleAttr = getAttr(childOpening, "style");
            const textStyleExpr = textStyleAttr?.value?.type === "JSXExpressionContainer" ? unwrapTs(textStyleAttr.value.expression) : null;
            const textClassAttr = getAttr(childOpening, "class");
            const textClassEntries = textClassAttr
              ? getMatchingClassEntries(childOpening, cssEnv.identToModule, cssEnv.classConsts, aliases)
              : [];

            let cssFontSizePx = null;
            let cssLineHeight = false;
            for (const entry of textClassEntries) {
              for (const decl of entry.block.declarations) {
                if (decl.prop === "font-size") cssFontSizePx = parseCssPx(decl.value);
                else if (decl.prop === "line-height") cssLineHeight = true;
              }
            }

            let inlineFontSizePx = null;
            let inlineLineHeight = false;
            if (textStyleExpr?.type === "ObjectExpression") {
              const { map } = getStyleProps(textStyleExpr);
              const fontSizeNode = map.get("fontSize") ?? map.get("font-size");
              inlineFontSizePx = fontSizeNode ? parsePx(fontSizeNode, aliases) : null;
              inlineLineHeight = analyzeStyleExpr(textStyleExpr).hasLineHeight;
            }

            const fontSizePx = inlineFontSizePx ?? cssFontSizePx;
            if (fontSizePx !== null && fontSizePx <= 12 && !inlineLineHeight && !cssLineHeight && !meta.hasLineHeight) {
              context.report({
                node: textStyleAttr ?? textClassAttr ?? childOpening,
                message: `Centered Text Badge Rule: compact badge <text> (fontSize ${fontSizePx}px <= 12px) must declare an explicit lineHeight (on <text> or its badge container) so inherited body line-height never shifts the glyph off vertical center.`,
              });
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
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };
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

      const findNegativeMarginValue = expr => {
        const node = unwrapTs(expr);
        if (!node) return null;
        if (node.type === "UnaryExpression" && node.operator === "-") {
          const arg = unwrapTs(node.argument);
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
        const node = unwrapTs(expr);
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
          cssEnv = loadImportedCssModules(program, context.filename);
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
          const styleAttr = getAttr(node, "style");
          const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
          if (styleExpr) {
            const hit = findNegativeMarginInStyle(styleExpr);
            if (hit) {
              context.report({
                node: styleAttr,
                message: `Partial Card Hover Rule: <${tag}> must not use negative margin (${hit.key}: ${hit.value}) to stretch hover hits inside a card — this causes clipped box-in-box hover highlights. Use M3InteractiveCard (stretched full-card hit layer) or SplitTile instead.`,
              });
            }
          }
          const classAttr = getAttr(node, "class");
          if (classAttr) {
            for (const entry of getMatchingClassEntries(node, cssEnv.identToModule, cssEnv.classConsts, aliases)) {
              for (const decl of entry.block.declarations) {
                if (!MARGIN_KEYS.has(decl.prop)) continue;
                if (/(?:^|\s)-\d/.test(decl.value.trim())) {
                  context.report({
                    node: classAttr,
                    message: `${entry.ref.mod.basename} (${entry.selMeta.selector}): Partial Card Hover Rule: <${tag}> must not use negative margin (${decl.prop}: ${decl.value}) to stretch hover hits inside a card — this causes clipped box-in-box hover highlights. Use M3InteractiveCard (stretched full-card hit layer) or SplitTile instead.`,
                  });
                }
              }
            }
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
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };
      const functionMap = new Map();

      const hasNonZeroPaddingInExpr = styleExpr => {
        let hit = false;
        visitValueBranches(unwrapTs(styleExpr), branch => {
          const obj = unwrapTs(branch);
          if (!obj || obj.type !== "ObjectExpression") return;
          const { map } = getStyleProps(obj);
          for (const key of ["padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "padding-top", "padding-right", "padding-bottom", "padding-left"]) {
            const val = map.get(key);
            if (!val) continue;
            visitValueBranches(val, leaf => {
              const str = resolveStaticText(unwrapTs(leaf), aliases);
              const edges = str !== null ? parseSpacingEdges(str) : null;
              if (edges && (edges.top > 0 || edges.right > 0 || edges.bottom > 0 || edges.left > 0)) {
                hit = true;
              }
            });
          }
        });
        return hit;
      };

      const hasNonZeroPadding = opening => {
        const styleExpr = findPropExpr(opening, "style");
        if (styleExpr && hasNonZeroPaddingInExpr(styleExpr)) return true;
        for (const entry of getMatchingClassEntries(opening, cssEnv.identToModule, cssEnv.classConsts, aliases)) {
          for (const decl of entry.block.declarations) {
            if (
              decl.prop === "padding" ||
              decl.prop === "padding-top" ||
              decl.prop === "padding-right" ||
              decl.prop === "padding-bottom" ||
              decl.prop === "padding-left" ||
              decl.prop === "padding-inline" ||
              decl.prop === "padding-block"
            ) {
              const edges = parseSpacingEdges(decl.value);
              if (edges && (edges.top > 0 || edges.right > 0 || edges.bottom > 0 || edges.left > 0)) {
                return true;
              }
            }
          }
        }
        return false;
      };

      const collectRadiusStringsFromExpr = (styleExpr, out = []) => {
        visitValueBranches(unwrapTs(styleExpr), branch => {
          const obj = unwrapTs(branch);
          if (!obj || obj.type !== "ObjectExpression") return;
          const { map } = getStyleProps(obj);
          const radius = map.get("borderRadius") ?? map.get("border-radius");
          if (!radius) return;
          visitValueBranches(radius, leaf => {
            const str = resolveStaticText(unwrapTs(leaf), aliases);
            if (str !== null) out.push(str.trim());
          });
        });
        return out;
      };

      const collectRadiusStrings = opening => {
        const out = [];
        const styleExpr = findPropExpr(opening, "style");
        if (styleExpr) collectRadiusStringsFromExpr(styleExpr, out);
        for (const entry of getMatchingClassEntries(opening, cssEnv.identToModule, cssEnv.classConsts, aliases)) {
          for (const decl of entry.block.declarations) {
            if (decl.prop === "border-radius") out.push(decl.value.trim());
          }
        }
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

      const hasStyleOrCss = opening =>
        Boolean(findPropExpr(opening, "style")) ||
        getElementClassRefs(opening, cssEnv.identToModule, cssEnv.classConsts).length > 0;

      return {
        Program(program) {
          aliases = collectStringAliases(program);
          cssEnv = loadImportedCssModules(program, context.filename);
          for (const stmt of program.body ?? []) {
            if (stmt.type === "FunctionDeclaration" && stmt.id?.name) {
              functionMap.set(stmt.id.name, stmt);
            }
          }
        },
        CallExpression(callNode) {
          if (callNode.callee?.type !== "Identifier" || callNode.callee.name !== "registerPluginBarWidget") return;
          const arg = callNode.arguments?.[0];
          if (!arg || arg.type !== "ObjectExpression") return;
          const renderProp = arg.properties.find(p => propertyName(p) === "render");
          if (!renderProp || renderProp.type !== "Property") return;
          collectJsxElements(renderProp.value, desc => {
            const descOpening = desc.openingElement;
            const descTag = descOpening?.name?.name;
            if (descTag !== "box" && descTag !== "row" && descTag !== "column") return;
            const wrapsChildElement = (desc.children ?? []).some(ch => ch.type === "JSXElement");
            if (!wrapsChildElement) return;
            const descStyle = findPropExpr(descOpening, "style");
            const descClass = findPropExpr(descOpening, "class");
            if (hasNonZeroPadding(descOpening)) {
              context.report({
                node: descStyle ?? descClass ?? descOpening,
                message: "Consistent Active/Hover Shape Rule: registerPluginBarWidget wrapper must use zero padding so plugin hover fills the full host slot.",
              });
            }
            const radii = collectRadiusStrings(descOpening);
            if (radii.length === 0 || radii.some(r => r !== "inherit")) {
              context.report({
                node: descStyle ?? descClass ?? descOpening,
                message: `Consistent Active/Hover Shape Rule: registerPluginBarWidget wrapper <${descTag}> must use borderRadius: "inherit" so plugin widgets inherit the host slot contour (found ${radii.length > 0 ? radii.join(", ") : "none"}).`,
              });
            }
          });
        },
        JSXElement(element) {
          const opening = element.openingElement;
          if (opening?.name?.type !== "JSXIdentifier") return;
          const tag = opening.name.name;
          const styleExpr = findPropExpr(opening, "style");
          const classExpr = findPropExpr(opening, "class");

          if (isPluginWidget && (tag === "Button" || tag === "control")) {
            const radii = collectRadiusStrings(opening);
            if (radii.length === 0 || radii.some(r => r !== "inherit")) {
              context.report({
                node: styleExpr ?? classExpr ?? opening,
                message: `Consistent Active/Hover Shape Rule: plugin widget root <${tag}> must use borderRadius: "inherit" so its hover highlight matches the host slot active capsule (found ${radii.length > 0 ? radii.join(", ") : "none"}).`,
              });
            }
          }

          if (
            (tag === "box" || tag === "row" || tag === "column") &&
            getAttr(opening, "data-active") &&
            !getAttr(opening, "data-qs-tile") &&
            hasStyleOrCss(opening)
          ) {
            const childControls = [];
            for (const child of element.children ?? []) {
              collectJsxElements(child, desc => {
                const descOpening = desc.openingElement;
                const descTag = descOpening?.name?.name;
                if (descTag === "Button" || descTag === "control") {
                  childControls.push(descOpening);
                }
              });
            }
            if (childControls.length > 0) {
              if (hasNonZeroPadding(opening)) {
                context.report({
                  node: styleExpr ?? classExpr ?? opening,
                  message: "Consistent Active/Hover Shape Rule: non-interactive [data-active] wrapper must use zero padding (padding: 0px) so child interactive hover fills the full active surface.",
                });
              }
              for (const descOpening of childControls) {
                if (!hasStyleOrCss(descOpening)) continue;
                const radii = collectRadiusStrings(descOpening);
                if (radii.length === 0 || radii.some(r => r !== "inherit")) {
                  context.report({
                    node: findPropExpr(descOpening, "style") ?? findPropExpr(descOpening, "class") ?? descOpening,
                    message: `Consistent Active/Hover Shape Rule: <${descOpening.name.name}> inside [data-active] wrapper must use borderRadius: "inherit" so hover and active shapes match (found ${radii.length > 0 ? radii.join(", ") : "none"}).`,
                  });
                }
              }
            }
          }

          if (getAttr(opening, "data-active-indicator") && hasStyleOrCss(opening)) {
            const indicatorRadii = collectRadiusStrings(opening);
            let badInset = false;
            if (styleExpr) {
              visitValueBranches(unwrapTs(styleExpr), branch => {
                const obj = unwrapTs(branch);
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
            }
            for (const entry of getMatchingClassEntries(opening, cssEnv.identToModule, cssEnv.classConsts, aliases)) {
              for (const decl of entry.block.declarations) {
                if (decl.prop === "left" || decl.prop === "top") {
                  const px = parseCssPx(decl.value);
                  if (px !== null && px !== 0) badInset = true;
                }
              }
            }
            if (badInset) {
              context.report({
                node: styleExpr ?? classExpr ?? opening,
                message: "Consistent Active/Hover Shape Rule: [data-active-indicator] must align flush (left: 0px, top: 0px) with its target <Button> hit box instead of shrinking inward.",
              });
            }
            const parentEl = element.parent?.type === "JSXElement" ? element.parent : null;
            if (parentEl && indicatorRadii.length > 0) {
              const pairedBtnRadii = [];
              collectJsxElements(parentEl, desc => {
                const descOpening = desc.openingElement;
                const descTag = descOpening?.name?.name;
                if (descTag === "Button" || descTag === "control") {
                  if (hasStyleOrCss(descOpening)) pairedBtnRadii.push(...collectRadiusStrings(descOpening));
                } else if (descTag && /^[A-Z]/.test(descTag) && functionMap.has(descTag)) {
                  collectJsxElements(functionMap.get(descTag), fnEl => {
                    const fnOpening = fnEl.openingElement;
                    const fnTag = fnOpening?.name?.name;
                    if (fnTag === "Button" || fnTag === "control") {
                      if (hasStyleOrCss(fnOpening)) pairedBtnRadii.push(...collectRadiusStrings(fnOpening));
                    }
                  });
                }
              });
              if (
                pairedBtnRadii.length > 0
                && JSON.stringify([...new Set(indicatorRadii)].sort()) !== JSON.stringify([...new Set(pairedBtnRadii)].sort())
              ) {
                context.report({
                  node: styleExpr ?? classExpr ?? opening,
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
      let cssEnv = { modules: [], identToModule: new Map(), classConsts: new Map() };
      const styleConsts = new Map();

      const resolveConstProps = (expr, branches) => {
        const node = unwrapTs(expr);
        if (!node) return null;
        if (node.type === "Identifier") {
          const cached = styleConsts.get(node.name);
          return cached ? resolveConstProps(cached, branches) : null;
        }
        if (node.type === "ConditionalExpression") {
          const cond = evalConditionForBranches(node.test, branches);
          if (cond !== null) {
            return resolveConstProps(cond ? node.consequent : node.alternate, branches);
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
        const node = unwrapTs(propExpr);
        if (!node) return null;
        if (node.type === "ConditionalExpression") {
          const cond = evalConditionForBranches(node.test, branches);
          if (cond !== null) {
            return evalPxProp(cond ? node.consequent : node.alternate, branches);
          }
          return null;
        }
        return parsePx(node, aliases);
      };

      const evalStylePadding = (map, branches) => {
        let top = 0;
        let right = 0;
        let bottom = 0;
        let left = 0;
        const padNode = map.get("padding");
        if (padNode) {
          const str = (() => {
            const node = unwrapTs(padNode);
            if (node?.type === "ConditionalExpression") {
              const cond = evalConditionForBranches(node.test, branches);
              if (cond !== null) {
                return resolveStaticText(unwrapTs(cond ? node.consequent : node.alternate), aliases);
              }
            }
            return resolveStaticText(node, aliases);
          })();
          const edges = str !== null ? parseSpacingEdges(str) : null;
          if (edges) ({ top, right, bottom, left } = edges);
        }
        const pt = map.has("paddingTop") ? evalPxProp(map.get("paddingTop"), branches) : null;
        const pr = map.has("paddingRight") ? evalPxProp(map.get("paddingRight"), branches) : null;
        const pb = map.has("paddingBottom") ? evalPxProp(map.get("paddingBottom"), branches) : null;
        const pl = map.has("paddingLeft") ? evalPxProp(map.get("paddingLeft"), branches) : null;
        if (pt !== null) top = pt;
        if (pr !== null) right = pr;
        if (pb !== null) bottom = pb;
        if (pl !== null) left = pl;
        return { x: left + right, y: top + bottom };
      };

      const resolveElementDimensions = (opening, branches) => {
        const cssMap = new Map();
        const classEntries = getMatchingClassEntries(opening, cssEnv.identToModule, cssEnv.classConsts, aliases, { branches });
        for (const entry of classEntries) {
          for (const decl of entry.block.declarations) {
            cssMap.set(decl.prop, decl.value);
          }
        }
        const styleAttr = getAttr(opening, "style");
        const styleExpr = styleAttr?.value?.type === "JSXExpressionContainer" ? styleAttr.value.expression : null;
        const styleProps = styleExpr ? resolveConstProps(styleExpr, branches) : null;

        if (classEntries.length === 0 && !styleProps) return null;

        const cssW = cssMap.has("width") ? parseCssPx(cssMap.get("width")) : null;
        const cssH = cssMap.has("height") ? parseCssPx(cssMap.get("height")) : null;
        const styleW = styleProps?.has("width") ? evalPxProp(styleProps.get("width"), branches) : undefined;
        const styleH = styleProps?.has("height") ? evalPxProp(styleProps.get("height"), branches) : undefined;
        const width = styleW !== undefined ? styleW : cssW;
        const height = styleH !== undefined ? styleH : cssH;

        let padLeft = 0;
        let padRight = 0;
        let padTop = 0;
        let padBottom = 0;
        if (cssMap.has("padding")) {
          const edges = parseSpacingEdges(cssMap.get("padding"));
          if (edges) {
            padTop = edges.top;
            padRight = edges.right;
            padBottom = edges.bottom;
            padLeft = edges.left;
          }
        }
        if (cssMap.has("padding-inline")) {
          const edges = parseSpacingEdges(cssMap.get("padding-inline"));
          if (edges) { padLeft = edges.left; padRight = edges.right; }
        }
        if (cssMap.has("padding-block")) {
          const edges = parseSpacingEdges(cssMap.get("padding-block"));
          if (edges) { padTop = edges.top; padBottom = edges.bottom; }
        }
        const cssPt = parseCssPx(cssMap.get("padding-top"));
        const cssPr = parseCssPx(cssMap.get("padding-right"));
        const cssPb = parseCssPx(cssMap.get("padding-bottom"));
        const cssPl = parseCssPx(cssMap.get("padding-left"));
        if (cssPt !== null) padTop = cssPt;
        if (cssPr !== null) padRight = cssPr;
        if (cssPb !== null) padBottom = cssPb;
        if (cssPl !== null) padLeft = cssPl;

        let padX = padLeft + padRight;
        let padY = padTop + padBottom;
        if (styleProps && (styleProps.has("padding") || styleProps.has("paddingTop") || styleProps.has("paddingRight") || styleProps.has("paddingBottom") || styleProps.has("paddingLeft"))) {
          const sPad = evalStylePadding(styleProps, branches);
          padX = sPad.x;
          padY = sPad.y;
        }

        return {
          width,
          height,
          pad: { x: padX, y: padY },
          reportNode: styleAttr ?? getAttr(opening, "class") ?? opening,
        };
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
          cssEnv = loadImportedCssModules(program, context.filename);
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
          const hasStyle = Boolean(getAttr(opening, "style"));
          const hasCss = getElementClassRefs(opening, cssEnv.identToModule, cssEnv.classConsts).length > 0;
          if (!hasStyle && !hasCss) return;

          const childButtons = findDirectChildButtons(element.children);
          if (childButtons.length === 0) return;

          for (const vertical of [false, true]) {
            for (const docked of [false, true]) {
              const branches = { vertical, docked };
              const parentDims = resolveElementDimensions(opening, branches);
              if (!parentDims) continue;
              const { width: pw, height: ph, pad } = parentDims;
              if (pw === null && ph === null) continue;

              for (const btn of childButtons) {
                const btnDims = resolveElementDimensions(btn, branches);
                if (!btnDims) continue;
                const { width: cw, height: ch, reportNode } = btnDims;
                if (pw !== null && cw !== null && cw + pad.x > pw) {
                  context.report({
                    node: reportNode,
                    message: `Child Control Overflow Rule: child <${btn.name.name}> width (${cw}px + ${pad.x}px padding) exceeds parent <${tag}> width (${pw}px) in ${vertical ? "vertical" : "horizontal"} ${docked ? "docked" : "floating"} mode.`,
                  });
                  return;
                }
                if (ph !== null && ch !== null && ch + pad.y > ph) {
                  context.report({
                    node: reportNode,
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
