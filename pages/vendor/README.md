# Vendored editor libraries

Prebuilt once, served as they are, loaded by `editor.js` with `import()`. Nothing comes from a CDN at runtime.

| File | What | Version |
|---|---|---|
| `codemirror.mjs` | CodeMirror 6, one ESM bundle of the parts the source pane uses | @codemirror/state 6.7.6, view 6.43.13, commands 6.11.1, autocomplete 6.20.3, language 6.12.4, legacy-modes 6.5.4 (stex) |
| `pdf.min.mjs`, `pdf.worker.min.mjs` | pdf.js, copied unchanged from `pdfjs-dist/build/` | pdfjs-dist 6.3.289 |

CodeMirror injects its base theme through a constructed stylesheet, which `style-src 'self'` allows. It also sets a
`tab-size` style attribute on its content element; the CSP blocks that one (a console error, nothing else), and
`editor.css` sets `tab-size` itself. pdf.js runs with `isEvalSupported: false`.

## Rebuilding

In a scratch directory outside the repo:

```
npm init -y
npm install pdfjs-dist@6.3.289 esbuild@0.28.2 @codemirror/state@6.7.6 @codemirror/view@6.43.13 \
  @codemirror/commands@6.11.1 @codemirror/autocomplete@6.20.3 @codemirror/language@6.12.4 @codemirror/legacy-modes@6.5.4
cat > cm-entry.mjs <<'EOF'
export { EditorState, StateField, StateEffect, RangeSetBuilder, RangeSet, Compartment, Transaction, EditorSelection, Prec, Annotation, Facet } from '@codemirror/state';
export { EditorView, Decoration, WidgetType, keymap, drawSelection, highlightSpecialChars, ViewPlugin, lineNumbers } from '@codemirror/view';
export { defaultKeymap, indentWithTab } from '@codemirror/commands';
export { autocompletion, completionKeymap, snippetCompletion, snippet, startCompletion, closeCompletion, completionStatus, acceptCompletion, currentCompletions, selectedCompletion } from '@codemirror/autocomplete';
export { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { stex } from '@codemirror/legacy-modes/mode/stex';
EOF
npx esbuild cm-entry.mjs --bundle --format=esm --minify --target=es2020 --legal-comments=eof --outfile=codemirror.mjs
cp node_modules/pdfjs-dist/build/pdf.min.mjs node_modules/pdfjs-dist/build/pdf.worker.min.mjs .
```

Then copy `codemirror.mjs`, `pdf.min.mjs` and `pdf.worker.min.mjs` here. The server must answer `/vendor/*.mjs` with a
JavaScript content type, or the browser refuses the module and pdf.js's worker.
