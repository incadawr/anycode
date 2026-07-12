/**
 * Assistant-message markdown renderer (design
 * /working-docs/ui-track/design/slice-R1-cut.md §4). Walks marked's block-token
 * array (lexer-only — no HTML string, no `dangerouslySetInnerHTML`, guardrail
 * §6.5) and emits React nodes. Every switch has a safe `default:` arm that
 * renders raw text and never throws, so an unknown/future token kind degrades
 * to literal text instead of breaking the transcript.
 *
 * Streaming: `memo` + `useMemo(lexMarkdown, [text])` make every non-tail
 * message a no-op during streaming (the store patches only the tail block in
 * place per rAF flush, keys are stable). Re-lexing tens of KB per frame is
 * trivially cheap; no further caching.
 *
 * Copy feedback is component-local ephemeral state (guardrail §6.7 — no store
 * touch, no new NoticeKind): the code-block button flips its own label, and a
 * clicked link grows a transient inline hint via the Markdown-instance copy
 * slot. No fixed-position toast ⇒ no drag-region hazard (§6.6).
 */
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Token, Tokens } from "marked";
import { decodeMarkedText, fenceLabel, lexMarkdown } from "../markdown/lex.js";
import {
  fontStyleToCss,
  highlightCode,
  langIdForFenceInfo,
  type DiffTheme,
  type HighlightedLine,
} from "../diff/highlight.js";
import { useResolvedTheme } from "../theme.js";
import { Check, Copy } from "./icons.js";

/** Single copy slot per Markdown instance (design §4): which link href, if any, is currently showing its transient "Copied" hint. */
interface CopyState {
  linkTarget: string | null;
  copyLink: (href: string) => void;
}

const CopyContext = createContext<CopyState>({ linkTarget: null, copyLink: () => {} });

/** Writes to the clipboard if available, swallowing rejection (no error theater for a clipboard edge). Returns whether a write was attempted. */
function tryClipboardWrite(text: string, onSuccess: () => void): void {
  const write = navigator.clipboard?.writeText(text);
  if (!write) {
    return;
  }
  void write.then(onSuccess).catch(() => {});
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => lexMarkdown(text), [text]);
  const [linkTarget, setLinkTarget] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const copyLink = useCallback((href: string) => {
    tryClipboardWrite(href, () => {
      setLinkTarget(href);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setLinkTarget(null), 1500);
    });
  }, []);

  const copyState = useMemo<CopyState>(() => ({ linkTarget, copyLink }), [linkTarget, copyLink]);

  return (
    <CopyContext.Provider value={copyState}>
      <BlockTokens tokens={tokens} />
    </CopyContext.Provider>
  );
});

/** Block-token array → elements. `default:` renders raw text in a `.md-p` — unknown/future kinds never throw. */
function BlockTokens({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.type) {
          case "space":
          case "def":
          case "checkbox":
            // Whitespace, link-reference metadata (already resolved by the
            // lexer), and the list-item checkbox marker (we render our own
            // native checkbox from `item.task`) carry no rendered output.
            return null;
          case "code": {
            const t = token as Tokens.Code;
            return (
              <CodeBlock
                key={index}
                code={t.text}
                langId={langIdForFenceInfo(t.lang)}
                label={fenceLabel(t.lang)}
              />
            );
          }
          case "heading": {
            const t = token as Tokens.Heading;
            const depth = Math.min(Math.max(Math.trunc(t.depth), 1), 6);
            const HeadingTag = `h${depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <HeadingTag key={index} className={`md-h${depth}`}>
                <InlineTokens tokens={t.tokens} />
              </HeadingTag>
            );
          }
          case "paragraph": {
            const t = token as Tokens.Paragraph;
            return (
              <p key={index} className="md-p">
                <InlineTokens tokens={t.tokens} />
              </p>
            );
          }
          case "blockquote": {
            const t = token as Tokens.Blockquote;
            return (
              <blockquote key={index} className="md-blockquote">
                <BlockTokens tokens={t.tokens} />
              </blockquote>
            );
          }
          case "list":
            return <MdList key={index} list={token as Tokens.List} />;
          case "table":
            return <Table key={index} table={token as Tokens.Table} />;
          case "hr":
            return <hr key={index} className="md-hr" />;
          case "html":
            // Raw block HTML is never interpreted (CSP/XSS law): render the
            // literal source as a plain text node inside a paragraph.
            return (
              <p key={index} className="md-p">
                {(token as Tokens.HTML).raw}
              </p>
            );
          case "text": {
            const t = token as Tokens.Text;
            return <InlineTokens key={index} tokens={t.tokens ?? [t]} />;
          }
          default:
            return (
              <p key={index} className="md-p">
                {token.raw}
              </p>
            );
        }
      })}
    </>
  );
}

/** Inline-token array → elements. `default:` renders decoded raw text — unknown/future kinds never throw. */
function InlineTokens({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.type) {
          case "text": {
            const t = token as Tokens.Text;
            return t.tokens ? (
              <InlineTokens key={index} tokens={t.tokens} />
            ) : (
              <Fragment key={index}>{decodeMarkedText(t.text)}</Fragment>
            );
          }
          case "escape":
            return <Fragment key={index}>{decodeMarkedText((token as Tokens.Escape).text)}</Fragment>;
          case "strong":
            return (
              <strong key={index}>
                <InlineTokens tokens={(token as Tokens.Strong).tokens} />
              </strong>
            );
          case "em":
            return (
              <em key={index}>
                <InlineTokens tokens={(token as Tokens.Em).tokens} />
              </em>
            );
          case "del":
            return (
              <del key={index}>
                <InlineTokens tokens={(token as Tokens.Del).tokens} />
              </del>
            );
          case "codespan":
            // Code-span content is verbatim (CommonMark): entity references are
            // NOT processed inside inline code. marked 18 leaves `codespan.text`
            // as literal source, so it is rendered raw — decoding here would
            // wrongly collapse an author's literal `&lt;`/`&amp;` in inline code.
            return (
              <code key={index} className="md-code-inline">
                {(token as Tokens.Codespan).text}
              </code>
            );
          case "br":
            return <br key={index} />;
          case "checkbox":
            // A GFM task item's checkbox token also appears nested inside a
            // paragraph's inline tokens for LOOSE (blank-line-separated) list
            // items; the native <input> is already rendered by MdList from
            // `item.task`, so drop the inline token to avoid a stray "[ ] ".
            return null;
          case "link": {
            const t = token as Tokens.Link;
            return (
              <MdLink key={index} href={t.href}>
                <InlineTokens tokens={t.tokens} />
              </MdLink>
            );
          }
          case "image": {
            const t = token as Tokens.Image;
            // Alt text only, never an <img> — CSP blocks remote loads, and a
            // broken-image glyph is worse than an honest label.
            return (
              <span key={index} className="md-image-alt">
                Image: {t.text || t.href}
              </span>
            );
          }
          case "html":
            // Inline raw HTML (e.g. `<span>`) rendered as a literal text node.
            return <Fragment key={index}>{(token as Tokens.HTML).raw}</Fragment>;
          default:
            return <Fragment key={index}>{decodeMarkedText(token.raw)}</Fragment>;
        }
      })}
    </>
  );
}

/** Ordered/unordered list; task items get a leading disabled native checkbox (state → screen readers, `color-scheme`-themed). */
function MdList({ list }: { list: Tokens.List }) {
  const start = list.ordered && typeof list.start === "number" && list.start !== 1 ? list.start : undefined;
  const items = list.items.map((item, index) => (
    <li key={index} className="md-li">
      {item.task && (
        <input
          type="checkbox"
          className="md-task-checkbox"
          aria-label={(item.checked ?? false) ? "Completed" : "Incomplete"}
          checked={item.checked ?? false}
          disabled
          readOnly
        />
      )}
      <BlockTokens tokens={item.tokens} />
    </li>
  ));
  return list.ordered ? (
    <ol className="md-list" start={start}>
      {items}
    </ol>
  ) : (
    <ul className="md-list">{items}</ul>
  );
}

/** GFM table; scrolls inside its own wrapper so a wide table never scrolls the page body sideways. */
function Table({ table }: { table: Tokens.Table }) {
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {table.header.map((cell, index) => (
              <th key={index} style={{ textAlign: cell.align ?? undefined }}>
                <InlineTokens tokens={cell.tokens} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} style={{ textAlign: cell.align ?? undefined }}>
                  <InlineTokens tokens={cell.tokens} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Real anchor (keyboard-focusable, Enter fires click) whose click is guarded:
 * navigation is prevented (a naked anchor would navigate this frameless window
 * away), the href is copied instead, and a transient "Copied" hint renders
 * beside the link for 1.5 s. `title={href}` doubles as an honest destination
 * preview. Opening links in the browser is a parked main-side follow-up
 * (`setWindowOpenHandler` + `shell.openExternal`); copy-on-click stays correct
 * even after that lands.
 */
function MdLink({ href, children }: { href: string; children: ReactNode }) {
  const copy = useContext(CopyContext);
  const copied = copy.linkTarget === href;
  return (
    <>
      <a
        className="md-link"
        href={href}
        title={href}
        onClick={(event) => {
          event.preventDefault();
          copy.copyLink(href);
        }}
      >
        {children}
      </a>
      {copied && <span className="md-copied-hint">Copied</span>}
    </>
  );
}

/**
 * Fenced/indented code well. Renders plain mono text synchronously (same font
 * and size as the eventual tokens, so colorization is an upgrade, never a
 * flash), then upgrades to Shiki token spans behind a 150 ms debounce — a block
 * streaming per-rAF collapses to ~one tokenization per pause. The DiffView
 * cancellation pattern (latest-wins `cancelled` flag) keeps a live theme flip
 * and rapid streaming coherent.
 */
function CodeBlock({ code, langId, label }: { code: string; langId: string | null; label: string | null }) {
  const resolvedTheme = useResolvedTheme();
  const shikiTheme: DiffTheme = resolvedTheme === "light" ? "github-light" : "github-dark";
  const [lines, setLines] = useState<HighlightedLine[] | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void highlightCode(code, langId, shikiTheme).then((result) => {
        if (!cancelled) {
          setLines(result.highlighted ? result.lines : null);
        }
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, langId, shikiTheme]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const onCopy = () => {
    tryClipboardWrite(code, () => {
      setCopied(true);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        {label && <span className="md-codeblock-lang">{label}</span>}
        <button
          type="button"
          className="md-codeblock-copy"
          data-copied={copied}
          aria-label="Copy code"
          onClick={onCopy}
        >
          {copied ? <Check /> : <Copy />}
        </button>
      </div>
      <pre className="md-codeblock-pre">
        <code>
          {lines
            ? lines.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {lineIndex > 0 && "\n"}
                  {line.map((tok, tokIndex) => (
                    <span key={tokIndex} style={{ color: tok.color, ...fontStyleToCss(tok.fontStyle) }}>
                      {tok.content}
                    </span>
                  ))}
                </Fragment>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
