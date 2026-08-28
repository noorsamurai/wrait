/**
 * A small, strict rich-text subset.
 *
 * Messages may carry formatting that someone pasted from a journal system, a
 * web page or Word. That means rendering markup written elsewhere, so the
 * rules here are deliberately narrow: an allowlist of tags, no attributes at
 * all except a scheme-checked href, and everything rebuilt from a parsed tree
 * rather than filtered with regexes - which is how sanitisers get bypassed.
 */

/** Tags worth keeping from a paste. Anything else becomes its text. */
const ALLOWED = new Set([
  "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL",
  "P", "BR", "UL", "OL", "LI", "CODE", "PRE", "BLOCKQUOTE", "A", "SPAN", "DIV",
]);

/** Rewritten to the tag that survives, so output stays predictable. */
const CANONICAL: Record<string, string> = {
  STRIKE: "s",
  DEL: "s",
  STRONG: "b",
  EM: "i",
  // A pasted div or span carries styling we drop; keep the text inline.
  DIV: "p",
  SPAN: "",
};

const BLOCK = new Set(["P", "UL", "OL", "LI", "PRE", "BLOCKQUOTE"]);

function safeHref(value: string): string | null {
  const trimmed = value.trim();
  // Only these two schemes: javascript:, data: and friends are how a pasted
  // link turns into script execution.
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function render(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(escapeText(node.nodeValue ?? ""));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const element = node as Element;
  const tag = element.tagName.toUpperCase();

  if (tag === "BR") {
    out.push("<br>");
    return;
  }

  if (!ALLOWED.has(tag)) {
    // Not allowed: keep what it said, drop what it was.
    for (const child of Array.from(element.childNodes)) render(child, out);
    return;
  }

  if (tag === "A") {
    const href = safeHref(element.getAttribute("href") ?? "");
    const inner: string[] = [];
    for (const child of Array.from(element.childNodes)) render(child, inner);
    if (href) {
      out.push(`<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">`);
      out.push(inner.join(""));
      out.push("</a>");
    } else {
      out.push(inner.join(""));
    }
    return;
  }

  const mapped = CANONICAL[tag] ?? tag.toLowerCase();
  const inner: string[] = [];
  for (const child of Array.from(element.childNodes)) render(child, inner);
  const content = inner.join("");

  if (!mapped) {
    out.push(content);
    return;
  }
  // An empty block would render as a stray blank line.
  if (!content.trim() && BLOCK.has(tag)) return;
  out.push(`<${mapped}>${content}</${mapped}>`);
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/** Reduces arbitrary HTML to the subset above. */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  for (const child of Array.from(parsed.body.childNodes)) render(child, out);
  return out.join("").trim();
}

/** Plain text of a message, for previews, notifications and task titles. */
export function htmlToPlain(html: string): string {
  if (!html) return "";
  if (!/[<&]/.test(html)) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  // Block boundaries become newlines so a pasted list does not run together.
  for (const block of Array.from(parsed.body.querySelectorAll("p,li,br,div"))) {
    block.insertAdjacentText("beforebegin", "\n");
  }
  return (parsed.body.textContent ?? "").replace(/\n{2,}/g, "\n").trim();
}

/** True when the body carries formatting rather than being plain text. */
export function isRich(body: string): boolean {
  return /<(b|i|u|s|a|p|ul|ol|li|code|pre|blockquote|br)\b/i.test(body);
}

/** Escapes plain text for rendering through the same path as rich bodies. */
export function plainToHtml(text: string): string {
  return escapeText(text).replace(/\n/g, "<br>");
}
