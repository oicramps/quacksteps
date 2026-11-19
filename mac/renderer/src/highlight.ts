// Syntax highlighting: Shiki's fine-grained core with the JS regex engine and a handful of grammars.
// The theme uses fixed marker colours that we map to CSS classes (.kw .st .nu .co .ty .fn), so the real
// colours come from the --kw/--str/--num/--com/--type/--fn variables that Swift sets per appearance.
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import css from "@shikijs/langs/css";
import go from "@shikijs/langs/go";
import graphql from "@shikijs/langs/graphql";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import kotlin from "@shikijs/langs/kotlin";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import scss from "@shikijs/langs/scss";
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import swift from "@shikijs/langs/swift";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";

export type Tok = readonly [cls: string, text: string];

const MARKERS: Record<string, string> = {
  "#010101": "kw",
  "#020202": "st",
  "#030303": "nu",
  "#040404": "co",
  "#050505": "ty",
  "#060606": "fn",
};

const theme = {
  name: "quack",
  type: "light" as const,
  settings: [
    { settings: { foreground: "#000000", background: "#ffffff" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "variable.language", "keyword.operator.new"], settings: { foreground: "#010101" } },
    { scope: ["keyword.operator", "keyword.operator.assignment", "keyword.operator.arithmetic", "keyword.operator.comparison", "keyword.operator.logical", "keyword.operator.relational"], settings: { foreground: "#000000" } },
    { scope: ["keyword.operator.new", "keyword.operator.expression", "keyword.operator.typeof", "keyword.operator.instanceof"], settings: { foreground: "#010101" } },
    { scope: ["string", "string.quoted", "string.template", "markup.inline.raw", "string.regexp"], settings: { foreground: "#020202" } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "support.constant", "constant.other.color"], settings: { foreground: "#030303" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#040404" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class", "entity.name.tag", "meta.type", "storage.type.class"], settings: { foreground: "#050505" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function", "meta.definition.function", "entity.other.attribute-name", "markup.heading"], settings: { foreground: "#060606" } },
  ],
};

const LANGS = [css, go, graphql, html, java, javascript, json, jsx, kotlin, markdown, python, ruby, scss, shellscript, sql, swift, tsx, typescript, yaml].flat();

const EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "json", swift: "swift", kt: "kotlin", kts: "kotlin", java: "java",
  css: "css", scss: "scss", html: "html", htm: "html", md: "markdown", mdx: "markdown",
  yml: "yaml", yaml: "yaml", sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  py: "python", rb: "ruby", go: "go", sql: "sql", graphql: "graphql", gql: "graphql",
};

export function languageFor(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

type Core = ReturnType<typeof createHighlighterCoreSync>;
let core: Core | null | undefined;

function highlighter(): Core | null {
  if (core === undefined) {
    try {
      core = createHighlighterCoreSync({ themes: [theme], langs: LANGS, engine: createJavaScriptRegexEngine({ forgiving: true }) });
    } catch {
      core = null;
    }
  }
  return core;
}

/** Tokens per line of `text`, or null when the language is unknown or highlighting fails. */
export function highlight(text: string, lang: string | null): Tok[][] | null {
  if (!lang) return null;
  const hl = highlighter();
  if (!hl) return null;
  try {
    const lines = hl.codeToTokensBase(text, { lang: lang as never, theme: "quack" });
    return lines.map((line) =>
      line.map((t) => [MARKERS[(t.color ?? "").toLowerCase()] ?? "", t.content] as const),
    );
  } catch {
    return null;
  }
}
