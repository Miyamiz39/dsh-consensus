const RECORD = /^\s*\[(\d+)\]\s+\[(.+)\]\((https?:\/\/[^\s()]+)\)\s*(?:\((.*)\))?\s*$/
const RECORD_ID = /^\s*id:\s*(\S+)\s*$/
// Consensus appends model-facing instructions and its plan notice after the last record.
const TRAILING_NOTICE = /^(?:IMPORTANT INSTRUCTIONS:|Upgrade to Consensus Pro|You must include the above|This plan allows up to|Found \d+ papers?)/

/**
 * Split the parenthetical after a record's link into its citation fields.
 * Both the author list and the venue may contain commas of their own, so the
 * four-digit year is the anchor and the citation count is recognized by shape.
 * @param {string} text - the parenthetical contents, without its brackets.
 * @returns {{authors: string, year: number | null, venue: string, citations: number | null}} citation fields.
 */
export function parseCitation(text) {
  const raw = String(text)
  // Read the citation count before splitting: a large count carries thousands separators,
  // which a plain comma split would cut into separate fields.
  const cited = /(?:^|,\s*)(\d[\d,]*)\s+citations?(?=,|$)/i.exec(raw)
  const citations = cited === null ? null : Number(cited[1].replace(/,/g, ''))
  const rest = cited === null ? raw : `${raw.slice(0, cited.index)}${raw.slice(cited.index + cited[0].length)}`
  const parts = rest.split(',').map(part => part.trim()).filter(Boolean)
  const year = parts.findIndex(part => /^\d{4}$/.test(part))
  const result = { authors: (year === -1 ? parts : parts.slice(0, year)).join(', '), year: null, venue: '', citations }
  if (year !== -1) result.year = Number(parts[year])
  for (const part of year === -1 ? [] : parts.slice(year + 1)) {
    result.venue = result.venue === '' ? part : `${result.venue}, ${part}`
  }
  return result
}

/**
 * Parse one Consensus search result into ranked paper records.
 * Every field is optional: a record without a parenthetical still yields its
 * title and link, and text that holds no record yields no papers.
 * @param {string} text - the search result's text content.
 * @returns {{total: number | null, papers: Array<object>}} the parsed payload.
 */
export function parseSearch(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  const found = /^Found (\d+) papers?/m.exec(source)
  const papers = []
  let current = null
  let abstract = []
  // The last record's abstract must survive the notice that follows it, and the
  // trailing notice itself belongs to no paper.
  const flush = () => {
    if (current) current.abstract = abstract.join('\n').replace(/\s+/g, ' ').trim()
    abstract = []
  }
  for (const line of source.split('\n')) {
    const record = RECORD.exec(line)
    if (record) {
      flush()
      current = { number: Number(record[1]), title: record[2].trim(), url: record[3], ...parseCitation(record[4] ?? ''), abstract: '' }
      papers.push(current)
      continue
    }
    if (current === null) continue
    if (TRAILING_NOTICE.test(line)) { flush(); current = null; continue }
    const id = RECORD_ID.exec(line)
    if (id) { current.id = id[1]; continue }
    if (line.trim() !== '') abstract.push(line.trim())
  }
  flush()
  return { total: found ? Number(found[1]) : null, papers }
}

/**
 * Count the papers a result header announces, for the inline summary that
 * renders before the full card is available.
 * @param {string} text - the search result's text content.
 * @returns {number | null} the announced total, or null when there is no header.
 */
export function announcedTotal(text) {
  const found = /^Found (\d+) papers?/m.exec(String(text ?? ''))
  return found ? Number(found[1]) : null
}
