// Answer text. react-markdown never renders raw HTML from the model and drops
// javascript: links; code blocks get grey-only highlighting (highlight.js
// classes mapped to the brand's greys in styles.css) and a copy button.
import { memo, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import dos from "highlight.js/lib/languages/dos";

const languages = { bash, c, cpp, csharp, css, diff, go, java, javascript, json, markdown, powershell, python, rust, sql, typescript, xml, yaml, dos };
for (const [name, lang] of Object.entries(languages)) hljs.registerLanguage(name, lang);
const ALIAS = { js: "javascript", jsx: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript", sh: "bash", shell: "bash",
  zsh: "bash", ps: "powershell", ps1: "powershell", pwsh: "powershell", py: "python", html: "xml", svg: "xml", yml: "yaml",
  md: "markdown", cs: "csharp", rs: "rust", cmd: "dos", bat: "dos", batch: "dos", jsonc: "json" };

export function highlight(text, lang) {
  const name = ALIAS[lang] || lang;
  if (!name || !hljs.getLanguage(name)) return null;
  try { return hljs.highlight(text, { language: name, ignoreIllegals: true }).value; } catch { return null; }
}

export function CopyButton({ text, label = "복사" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="mini-btn"
      onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); })}
    >
      {done ? "복사했어요" : label}
    </button>
  );
}

export function CodeBlock({ lang, text }) {
  const html = useMemo(() => highlight(text, lang), [text, lang]);
  return (
    <div className="code">
      <div className="code-head">
        <span className="code-lang">{lang || "text"}</span>
        <CopyButton text={text} />
      </div>
      <pre>{html != null ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{text}</code>}</pre>
    </div>
  );
}

const components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const lang = ((child?.props?.className || "").match(/language-([\w+#.-]+)/) || [])[1] || "";
    const text = String(child?.props?.children ?? "").replace(/\n$/, "");
    return <CodeBlock lang={lang.toLowerCase()} text={text} />;
  },
  a({ href, children }) {
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  table({ children }) {
    return <div className="table-wrap"><table>{children}</table></div>;
  },
  img({ alt }) {
    return <span className="img-alt">[그림{alt ? `: ${alt}` : ""}]</span>;
  },
};

export const Markdown = memo(function Markdown({ text, streaming }) {
  return (
    <div className={`md${streaming ? " streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
});
