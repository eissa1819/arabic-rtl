import type { Register, RenderNode } from 'claude-code'

// Arabic script ranges (Arabic, Supplement, Extended, Presentation Forms).
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g
const LATIN = /[A-Za-z]/g
// Right-to-left isolate: makes the whole line one RTL block even when the
// surface lays the paragraph out left-to-right.
const RLI = '\u2067'
const LRI = '\u2066'
const PDI = '\u2069'
// A run of English: starts and ends on a letter/digit (or closing bracket/slash),
// may hold spaces and code-ish punctuation, never Arabic.
const LTR_RUN = /[A-Za-z0-9](?:[A-Za-z0-9_.\/\\:@#~+\-=<>()'"!?,&%* \t]*[A-Za-z0-9)\]\/%])?/g
const HAS_ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/

/** Wraps each English run in a left-to-right isolate so it can't scramble the Arabic around it. */
function iso(text: string): string {
  return text.replace(LTR_RUN, run => `${LRI}${run}${PDI}`)
}

const FENCE = /^\s*(```|~~~)/
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g

/** True when the prose (code removed) is mostly Arabic. */
function isArabic(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  const ar = prose.match(ARABIC)?.length ?? 0
  const la = prose.match(LATIN)?.length ?? 0
  return ar > 0 && ar >= la * 0.4
}

type Kit = { Box: any; Text: any; Link: any; Markdown: any }

/**
 * One line of markdown as a single plain string. Styled pieces (code, bold,
 * links) are not split into nested Text elements: the desktop app lays those
 * out as separate left-to-right boxes, which scrambles the Arabic order.
 */
function inline(_k: Kit, line: string, _key: string): string {
  return line
    .split(INLINE)
    .map(part => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return LRI + part.slice(1, -1) + PDI
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return iso(part.slice(2, -2))
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
      if (m) return iso(m[1] ?? '')
      return iso(part)
    })
    .join('')
}

type RowStyle = { weight?: 'bold'; dimColor?: boolean }

/**
 * One RTL line laid out word by word from the right edge: a row-reverse,
 * wrapping Box, so a line too long for the width continues on the next line
 * from the right too. English runs (LRI…PDI) stay whole as one word. The gap
 * between words is a no-break space on each word's left (the surface's
 * `columnGap` steps are wider than a space).
 */
function row(k: Kit, id: string, text: string, style: RowStyle = {}, indent = 0) {
  const words = text.split(/(\u2066[^\u2069]*\u2069)|\s+/).filter((w): w is string => !!w)
  return (
    <k.Box key={id} flexDirection="row-reverse" flexWrap="wrap" columnGap={0} width="100%" paddingRight={indent}>
      {words.map((w, i) => (
        <k.Text key={`${id}-${i}`} {...style}>{(i === words.length - 1 ? '' : '\u00A0') + (w.startsWith(LRI) ? w : RLI + w + PDI)}</k.Text>
      ))}
    </k.Box>
  )
}

/** Markdown → a column of RTL rows; code fences and tables stay as Markdown. */
function rtlTree(k: Kit, text: string) {
  const lines = text.split('\n')
  const rows: RenderNode[] = []
  let n = 0
  const key = () => `r${n++}`

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    if (FENCE.test(line)) {
      const start = i
      const mark = line.trim().slice(0, 3)
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(mark)) i++
      rows.push(<k.Markdown key={key()} text={lines.slice(start, i + 1).join('\n')} />)
      continue
    }
    if (line.trim().startsWith('|')) {
      const start = i
      while (i + 1 < lines.length && (lines[i + 1] ?? '').trim().startsWith('|')) i++
      rows.push(<k.Markdown key={key()} text={lines.slice(start, i + 1).join('\n')} />)
      continue
    }
    if (line.trim() === '') {
      rows.push(<k.Text key={key()}> </k.Text>)
      continue
    }
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      rows.push(<k.Text key={key()} dimColor>────────────</k.Text>)
      continue
    }

    const id = key()
    if (!HAS_ARABIC.test(line)) {
      // An English-only line inside an Arabic reply: keep it left-to-right, on the left.
      rows.push(<k.Box key={id} alignSelf="flex-start"><k.Text dir="ltr">{line}</k.Text></k.Box>)
      continue
    }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line)
    if (hd) {
      rows.push(row(k, id, inline(k, (hd[2] ?? '').replace(/\*\*/g, ''), id), { weight: 'bold' }))
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      rows.push(row(k, id, '┃ ' + inline(k, q[1] ?? '', id), { dimColor: true }))
      continue
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      const depth = Math.floor((li[1] ?? '').length / 2)
      const bullet = /\d/.test(li[2] ?? '') ? li[2] : '•'
      rows.push(row(k, id, `${bullet} ${inline(k, li[3] ?? '', id)}`, {}, depth * 2))
      continue
    }
    rows.push(row(k, id, inline(k, line, id)))
  }

  return <k.Box flexDirection="column" width="100%" alignItems="flex-end">{rows}</k.Box>
}

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.props.isSummary || !isArabic(e.props.text)) return next(e)
    return rtlTree($.ui.resolve(e) as unknown as Kit, e.props.text)
  })

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const p = e.props
    if (p.task || p.from || !isArabic(p.text)) return next(e)
    const k = $.ui.resolve(e) as unknown as Kit
    return (
      <k.Box flexDirection="column" width="100%" alignItems="flex-end">
        {p.text.split('\n').map((l, i) =>
          l.trim() === '' ? <k.Text key={`u${i}`}> </k.Text>
          : HAS_ARABIC.test(l) ? row(k, `u${i}`, iso(l))
          : <k.Box key={`u${i}`} alignSelf="flex-start"><k.Text>{l}</k.Text></k.Box>
        )}
      </k.Box>
    )
  })
}
