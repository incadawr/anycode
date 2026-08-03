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
import { isLocalMdHref, resolveDocRelative } from "../markdown/doc-links.js";
import { classifyHtmlToken } from "../markdown/html-token.js";
import {
  fontStyleToCss,
  highlightCode,
  langIdForFenceInfo,
  type DiffTheme,
  type HighlightedLine,
} from "../diff/highlight.js";
import { useResolvedTheme } from "../theme.js";
import {
  artifactActionFailureMessage,
  artifactAllowFailureMessage,
  artifactChipState,
  type ConsentAttemptStatus,
} from "./artifact-messages.js";
import { Check, Copy } from "./icons.js";
import { TabContext } from "../tab-context.js";

/** Single copy slot per Markdown instance (design §4): which link href, if any, is currently showing its transient "Copied" hint. */
interface CopyState {
  linkTarget: string | null;
  copyLink: (href: string) => void;
}

const CopyContext = createContext<CopyState>({ linkTarget: null, copyLink: () => {} });

/**
 * TASK.72: the active tab's id, needed by the artifact IPC (main scopes
 * containment to THAT tab's workspace). Read off the same TabContext
 * MessageList uses; `null` outside a tab (tests, Storybook-ish mounts) —
 * every artifact surface degrades to the plain copy-link in that case.
 */
const MarkdownTabContext = createContext<string | null>(null);

/**
 * TASK.99 M2 (CUT.md CONTRACTS): parameterizes `Markdown` for the native
 * md-doc preview WITHOUT forking the component. Default `null` IS the chat
 * path and is a HARD invariant (risk register #6): every read of this
 * context below is additive-only, gated behind `!== null`, and never changes
 * what renders when it is null — chat rendering stays byte-identical.
 * Set ONLY by `MarkdownPreviewView.tsx`.
 */
export interface MdDocContextValue {
  /** Absolute directory the CURRENT document lives in — the resolver anchor for a doc-relative image href (mirrors `MdDomPreviewRecord.docDir`, preview-host.ts). */
  docDir: string;
  /** A local `.md` link was clicked — the preview replaces its content in place (MD_PREVIEW_NAVIGATE), never opens a second preview. */
  onOpenMdLink(href: string): void;
}

export const MdDocContext = createContext<MdDocContextValue | null>(null);

const INLINE_PREVIEW_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const OPENABLE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".tiff", ".tif", ".heic"]);
/** Night-track wave-1: local doc links the PreviewHost window can render (mirrors main/artifacts-ipc.ts's PREVIEWABLE_DOC_EXTENSIONS). */
const PREVIEWABLE_ARTIFACT_EXTENSIONS = new Set([".html", ".htm", ".md"]);

function extensionOfHref(href: string): string {
  const base = href.slice(href.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * TASK.72: is this link target a local filesystem path the artifact IPC can
 * act on (vs a URL — http/mailto/any scheme — or an anchor)? Absolute POSIX
 * (`/…`), absolute win32 (`C:\…` / `C:/…`), home-anchored (`~/…`), and
 * bare relative paths (`out/icon.png`, `./icon.png`, `../x.png`) all
 * qualify; main resolves the relative form against the tab's workspace.
 */
function isLocalFileHref(href: string): boolean {
  if (href.startsWith("#")) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:[/\\]/.test(href)) {
    return false; // has a URI scheme and is not a win32 drive path
  }
  return true;
}

function isInlinePreviewHref(href: string): boolean {
  return isLocalFileHref(href) && INLINE_PREVIEW_EXTENSIONS.has(extensionOfHref(href));
}

/**
 * Night-track wave-1 (owner ask): a local `.html`/`.htm`/`.md` link the click
 * can open directly in the PreviewHost window, closing the "closed the
 * preview, now stuck" gap — today the window is reachable only via an agent
 * tool or turn-end auto-open.
 */
function isPreviewableArtifactHref(href: string): boolean {
  return isLocalFileHref(href) && PREVIEWABLE_ARTIFACT_EXTENSIONS.has(extensionOfHref(href));
}

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
  const tabId = useContext(TabContext)?.tabId ?? null;

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
      <MarkdownTabContext.Provider value={tabId}>
        <BlockTokens tokens={tokens} />
      </MarkdownTabContext.Provider>
    </CopyContext.Provider>
  );
});

/** Block-token array → elements. `default:` renders raw text in a `.md-p` — unknown/future kinds never throw. */
function BlockTokens({ tokens }: { tokens: Token[] }) {
  const mdDoc = useContext(MdDocContext);
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
          case "html": {
            // Raw block HTML is never interpreted as an HTML string (CSP/XSS
            // law, guardrail §6.5 — this never changes, no
            // `dangerouslySetInnerHTML`). The DOCUMENT path (`mdDoc !== null`,
            // owner smoke-test fix #2) additionally asks the pure classifier
            // for a verdict: a comment renders as nothing, an allowlisted
            // inert tag's OWN markup renders as nothing (its content, if any,
            // is a separate sibling token already rendering normally — `br`
            // renders as a line break instead). Anything else, and the chat
            // path (`mdDoc === null`) unconditionally, keeps the literal
            // source text — byte-identical to before this fix.
            const t = token as Tokens.HTML;
            if (mdDoc !== null) {
              const verdict = classifyHtmlToken(t.raw);
              if (verdict.kind === "hidden") {
                return null;
              }
              if (verdict.kind === "unwrap") {
                return verdict.tag === "br" ? <br key={index} /> : null;
              }
            }
            return (
              <p key={index} className="md-p">
                {t.raw}
              </p>
            );
          }
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
  const mdDoc = useContext(MdDocContext);
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
            // TASK.72: a LOCAL image (`![alt](/path/in/workspace.png)`)
            // renders the real inline preview (main-side containment-checked
            // read). A remote/URL image keeps the honest alt-text label —
            // CSP blocks remote loads, and a broken-image glyph is worse
            // than an honest label.
            if (isInlinePreviewHref(t.href)) {
              return <ArtifactPreview key={index} path={t.href} alt={t.text} />;
            }
            if (isLocalFileHref(t.href)) {
              return (
                <span key={index} className="md-image-alt">
                  Image: {t.text || t.href}
                  <ArtifactReveal path={t.href} />
                </span>
              );
            }
            return (
              <span key={index} className="md-image-alt">
                Image: {t.text || t.href}
              </span>
            );
          }
          case "html": {
            // Inline raw HTML (e.g. `<span>`) is never interpreted as an HTML
            // string (CSP/XSS law, guardrail §6.5 — unchanged). The DOCUMENT
            // path (`mdDoc !== null`, owner smoke-test fix #2) asks the same
            // pure classifier as the block arm above for a verdict — see its
            // comment for the hidden/unwrap/literal rundown. The chat path
            // (`mdDoc === null`) always falls through to the original literal
            // text node, byte-identical to before this fix.
            const t = token as Tokens.HTML;
            if (mdDoc !== null) {
              const verdict = classifyHtmlToken(t.raw);
              if (verdict.kind === "hidden") {
                return null;
              }
              if (verdict.kind === "unwrap") {
                return verdict.tag === "br" ? <br key={index} /> : null;
              }
            }
            return <Fragment key={index}>{t.raw}</Fragment>;
          }
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
 * away). For a local `.html`/`.htm`/`.md` artifact the click opens/reopens it
 * in the PreviewHost window instead (night-track wave-1, owner ask) — a
 * dedicated copy-icon button next to the link keeps the old copy-on-click
 * affordance reachable. Every other local/remote link keeps the original
 * copy-href behavior, with a transient "Copied" hint beside it for 1.5 s.
 * `title={href}` doubles as an honest destination preview. Opening remote
 * links in the browser is a parked main-side follow-up (`setWindowOpenHandler`
 * + `shell.openExternal`); this behavior stays correct even after that lands.
 *
 * TASK.99 M2: inside a native md-doc preview (`MdDocContext` set), a LOCAL
 * `.md` link REPLACES this preview's content in place (MD_PREVIEW_NAVIGATE)
 * instead of opening a NEW preview via `artifacts.preview` — every other
 * link (remote, `.html`/`.htm`, non-md local) keeps the exact chat behavior
 * below unchanged, context or not (CUT.md CONTRACTS: "other local links keep
 * chat behavior"). `mdDoc === null` (chat) makes this branch dead code, byte-
 * identical to pre-M2.
 */
function MdLink({ href, children }: { href: string; children: ReactNode }) {
  const copy = useContext(CopyContext);
  const tabId = useContext(MarkdownTabContext);
  const mdDoc = useContext(MdDocContext);
  const api = typeof window !== "undefined" ? window.anycode?.artifacts : undefined;
  const copied = copy.linkTarget === href;
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewable = isPreviewableArtifactHref(href) && tabId !== null && api !== undefined;

  const onClick = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    if (mdDoc !== null && isLocalMdHref(href)) {
      mdDoc.onOpenMdLink(href);
      return;
    }
    if (isPreviewableArtifactHref(href) && tabId !== null && api !== undefined) {
      void api.preview(tabId, href).then((result) => {
        setPreviewError(result.ok ? null : result.error);
      });
    } else {
      copy.copyLink(href);
    }
  };

  return (
    <>
      <a className="md-link" href={href} title={href} onClick={onClick}>
        {children}
      </a>
      {previewable && (
        <button
          type="button"
          className="md-link-copy"
          aria-label="Copy link"
          title="Copy link"
          onClick={() => copy.copyLink(href)}
        >
          {copied ? <Check /> : <Copy />}
        </button>
      )}
      {copied && <span className="md-copied-hint">Copied</span>}
      {previewError !== null && <span className="md-artifact-error">{previewError}</span>}
      {isInlinePreviewHref(href) ? <ArtifactPreview path={href} /> : isLocalFileHref(href) ? <ArtifactReveal path={href} /> : null}
    </>
  );
}

// ── TASK.72: chat-artifact preview (inline thumbnail + open/reveal) ──

type ArtifactState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string; sizeBytes: number; dimensions?: string }
  // `reason` is the RAW IPC reason code (e.g. "outside_allowed_roots"), not
  // pre-formatted text: the chip-state machine (artifact-messages.ts) needs
  // the code to decide whether to offer "Allow preview", and formats the
  // row's copy itself.
  | { status: "unavailable"; reason: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Inline preview of an image the agent created on disk, with Open (system
 * default viewer) and Reveal (show in folder) actions. Bytes are fetched
 * lazily — main re-checks containment (tab workspace / ~/.anycode / tmpdir,
 * symlink-resolved) and the image allowlist before every read/open/reveal,
 * so this component never holds a `file://` URL (CSP) and never triggers an
 * execution-capable open itself. Without a tab context (or without the
 * preload API in a test mount) it renders nothing — the link alone stays.
 *
 * TASK.99 M2: inside a native md-doc preview, `path` (the AUTHORED href) is
 * resolved against `MdDocContext.docDir` BEFORE it reaches any IPC call
 * below — the existing containment/size-cap/data:-URI custody chain
 * (`api.readImage` et al.) is reused completely unchanged, only the STRING
 * handed to it differs. `mdDoc === null` (chat) makes `resolvedPath === path`
 * unconditionally, so chat rendering is byte-identical to pre-M2.
 */
function ArtifactPreview({ path, alt }: { path: string; alt?: string }) {
  const tabId = useContext(MarkdownTabContext);
  const mdDoc = useContext(MdDocContext);
  const resolvedPath = mdDoc !== null ? (resolveDocRelative(mdDoc.docDir, path) ?? path) : path;
  const api = typeof window !== "undefined" ? window.anycode?.artifacts : undefined;
  const rootRef = useRef<HTMLSpanElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [state, setState] = useState<ArtifactState>({ status: "idle" });
  // Open/Reveal failures are reported beside the buttons rather than through
  // `state`: the preview above may be perfectly fine while the action is refused.
  const [actionError, setActionError] = useState<string | null>(null);
  // TASK.77-A: bumped after a successful Allow grant to re-run the read below
  // for the SAME path — the grant itself lives main-side; this is only the
  // renderer's retry trigger.
  const [attempt, setAttempt] = useState(0);
  const [consentAttempt, setConsentAttempt] = useState<ConsentAttemptStatus>("idle");
  const startLoad = () => {
    setState({ status: "loading" });
    setShouldLoad(true);
  };

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        startLoad();
        observer.disconnect();
      }
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!tabId || !api || !shouldLoad) {
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void api.readImage(tabId, resolvedPath).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setState({ status: "ready", url: `data:${result.mime};base64,${result.dataBase64}`, sizeBytes: result.sizeBytes });
      } else {
        setState({ status: "unavailable", reason: result.reason });
      }
    });
    return () => {
      cancelled = true;
    };
    // `attempt` is a deliberate re-fetch trigger (TASK.77-A's Allow retry) —
    // its value is never read, only its change matters.
  }, [tabId, api, resolvedPath, shouldLoad, attempt]);

  if (!tabId || !api) {
    return null;
  }

  const runAction = async (action: "open" | "reveal"): Promise<void> => {
    const result = action === "open" ? await api.open(tabId, resolvedPath) : await api.reveal(tabId, resolvedPath);
    setActionError(result.ok ? null : artifactActionFailureMessage(result.reason));
  };
  const open = () => void runAction("open");
  const reveal = () => void runAction("reveal");
  // TASK.77-A: an explicit click on this ONE path is the consent the OS
  // "open outside the workspace" modal exists to collect — main widens WHERE
  // (never WHAT: the extension/size gates are untouched) for this realPath,
  // then the read is retried so a successful grant renders the real preview.
  const allowPreview = async (): Promise<void> => {
    setConsentAttempt("pending");
    const result = await api.allow(tabId, resolvedPath);
    if (result.ok) {
      setConsentAttempt("idle");
      setAttempt((n) => n + 1);
    } else {
      setConsentAttempt("failed");
      setActionError(artifactAllowFailureMessage(result.reason));
    }
  };
  // night-track wave-1 fix cut §1.8 (F7): a model-authored `alt` may only ever
  // title a successfully rendered image — every other state names the
  // resolved path so a friendly `alt` can never mask what location is being
  // asked about (consent legibility; TASK.99 M2 — the RESOLVED path is the
  // actual location, more informative than the authored doc-relative href).
  const label = state.status === "ready" ? alt || resolvedPath : resolvedPath;
  const openable = OPENABLE_IMAGE_EXTENSIONS.has(extensionOfHref(resolvedPath));
  const chip = artifactChipState(state.status, state.status === "unavailable" ? state.reason : undefined, consentAttempt);

  return (
    <span ref={rootRef} className="md-artifact" data-status={state.status}>
      {state.status === "idle" && <button type="button" className="md-artifact-load" onClick={startLoad}>Load preview</button>}
      {state.status === "loading" && <span className="md-artifact-loading">Loading preview…</span>}
      {state.status === "ready" && (
        <img className="md-artifact-img" src={state.url} alt={label} onClick={openable ? open : undefined}
          onLoad={(event) => {
            const { naturalHeight, naturalWidth } = event.currentTarget;
            setState((current) => current.status === "ready" ? { ...current, dimensions: `${naturalWidth}×${naturalHeight}` } : current);
          }} title={openable ? `${resolvedPath} — click to open` : resolvedPath} />
      )}
      {state.status === "unavailable" && (
        <>
          <span className="md-artifact-error">{chip.label}</span>
          {chip.showPath && <code className="md-artifact-path">{resolvedPath}</code>}
          {chip.showAllow && (
            <button
              type="button"
              className="md-artifact-btn"
              disabled={consentAttempt === "pending"}
              onClick={() => void allowPreview()}
            >
              {consentAttempt === "pending" ? "Allowing…" : "Allow preview"}
            </button>
          )}
        </>
      )}
      <span className="md-artifact-meta">
        <span className="md-artifact-name" title={resolvedPath}>
          {label}
          {state.status === "ready" ? ` — ${state.dimensions ? `${state.dimensions} ` : ""}${formatBytes(state.sizeBytes)}` : ""}
        </span>
        <span className="md-artifact-actions">
          {openable && chip.showOpen && <button type="button" className="md-artifact-btn" onClick={open}>Open</button>}
          {chip.showReveal && (
            <button type="button" className="md-artifact-btn" onClick={reveal}>
              Reveal
            </button>
          )}
          {actionError !== null && <span className="md-artifact-error">{actionError}</span>}
        </span>
      </span>
    </span>
  );
}

/**
 * Local non-images get a Reveal action; `.html`/`.htm`/`.md` also get a
 * Preview action (night-track wave-1, owner ask) — the same call the link's
 * own click makes, offered here too for discoverability.
 */
function ArtifactReveal({ path }: { path: string }) {
  const tabId = useContext(MarkdownTabContext);
  const api = typeof window !== "undefined" ? window.anycode?.artifacts : undefined;
  const [failure, setFailure] = useState<string | null>(null);
  if (!tabId || !api) return null;
  const reveal = async (): Promise<void> => {
    const result = await api.reveal(tabId, path);
    setFailure(result.ok ? null : artifactActionFailureMessage(result.reason));
  };
  const preview = async (): Promise<void> => {
    const result = await api.preview(tabId, path);
    setFailure(result.ok ? null : result.error);
  };
  return (
    <>
      {PREVIEWABLE_ARTIFACT_EXTENSIONS.has(extensionOfHref(path)) && (
        <button type="button" className="md-artifact-btn md-artifact-preview-link" onClick={() => void preview()}>Preview</button>
      )}
      <button type="button" className="md-artifact-btn md-artifact-reveal-link" onClick={() => void reveal()}>Reveal in folder</button>
      {failure !== null && <span className="md-artifact-error">{failure}</span>}
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
