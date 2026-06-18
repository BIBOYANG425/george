// Strip markdown formatting from George's replies at the presentation boundary.
//
// WeChat and iMessage render markdown literally — "**bold**" shows the asterisks,
// not bold text. master.md tells the model to never emit markdown, but models
// (especially non-Claude backends like DeepSeek) still do. This removes the
// common markdown tokens so the user never sees raw "**", "`", or "##".
//
// It strips only FORMATTING markers; the text content, line breaks, and
// paragraph structure are preserved. Intentionally conservative: underscores
// inside identifiers (foo_bar) and bare asterisks are left alone so we don't
// mangle non-markdown text.

export function stripMarkdown(text: string): string {
  if (!text) return text
  let out = text

  // Fenced code blocks: drop the ``` fence lines, keep the inner content.
  out = out.replace(/^[ \t]*```[^\n]*\n?/gm, '')

  // ATX headings: strip the leading hashes ("## Title" -> "Title").
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')

  // Bold first (so ** is not half-consumed by the italic rule), then italic.
  out = out.replace(/\*\*([^\n]+?)\*\*/g, '$1')
  out = out.replace(/__([^\n]+?)__/g, '$1')
  out = out.replace(/\*([^\s*][^\n*]*?)\*/g, '$1')
  // Italic underscores only when not inside a word (skip foo_bar, file_name).
  out = out.replace(/(^|[^A-Za-z0-9_])_([^\s_][^\n_]*?)_(?=[^A-Za-z0-9_]|$)/g, '$1$2')

  // Inline code: drop the backticks, keep the content.
  out = out.replace(/`([^`\n]+)`/g, '$1')

  return out
}
