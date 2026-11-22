// Fast drop-in for csv-reader 1.0.0, make.fun's own CSV reader.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for the same
// input ({text, header} -> {columns, rows, errors}), on every case. The
// reference is the kit's baselines/csv-reader/vendor/csv-reader/index.js:
// it walks the text one character at a time, building each field a character
// at a time. This module keeps every one of its rules and only changes how
// the text is scanned:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote, and each CRLF or lone CR inside it
//     read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the text
//     after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met, a field's
//     quote_junk when the field ends and a record's short_row or long_row
//     when the record ends: line the 1-based line its record starts on,
//     counting every LF, CRLF and lone CR inside quotes, and row its
//     record's index in rows, null for the header.
//
// Speed comes from never walking one character at a time:
//
//   - Most records are plain: no quote, no stray CR. A plain record is read
//     with one indexOf for its line break, one slice and one native split
//     on commas. That is the whole record in a handful of native calls.
//   - Any other record is read field by field, but each field still jumps
//     with indexOf to its next comma or line break and slices it in one go,
//     instead of appending a character at a time. A quoted field jumps to
//     its closing quote the same way; only a quoted field that spans lines
//     (a note) is walked, and only inside that one field.
//   - A stray CR is the only reason an unquoted field needs more than one
//     slice, and it is rare: the field is split on '\r' only then.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. One run(input) answers one case alone.

const COMMA = 0; // the field ended at a comma: the record goes on
const LINE_BREAK = 1; // the field ended at a line break: the record ends
const END = 2; // the field ended at the end of the text: the record ends

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = typeof input.text === 'string' ? input.text : String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these two.
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and (for the quote_junk
  // check only) how many characters the unquoted tail of it kept. Kept in
  // plain variables, not an object per field, so reading a field allocates
  // nothing but the field's own string.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field onto `value`, starting at pos: up to the next
  // comma or line break. A CR not followed by LF is dropped (stray_cr).
  // Sets fValue, fEnded and fAdded (the characters kept by this call, not
  // counting the `value` it started with).
  function readUnquoted(value) {
    const cIdx = text.indexOf(',', pos);
    const nIdx = text.indexOf('\n', pos);
    let end;
    let ended;
    if (cIdx === -1 && nIdx === -1) {
      end = len;
      ended = END;
    } else if (nIdx === -1 || (cIdx !== -1 && cIdx < nIdx)) {
      end = cIdx;
      ended = COMMA;
    } else {
      end = nIdx;
      ended = LINE_BREAK;
    }
    let seg = text.slice(pos, end);
    let added = seg.length;
    if (seg.indexOf('\r') !== -1) {
      // A CR right before the LF is the CRLF line break itself, not a stray
      // one; every other CR in the field is lone: dropped, one stray_cr
      // error each. (The CRLF one is the LAST character of the field, even
      // when a lone CR stands before it: "x\r\r\n" is one stray_cr, not two.)
      let keep = seg;
      if (ended === LINE_BREAK && seg.charCodeAt(seg.length - 1) === 13) {
        keep = seg.slice(0, -1);
        added -= 1;
      }
      const parts = keep.split('\r');
      if (parts.length > 1) {
        for (let i = 0; i < parts.length - 1; i++) pushError('stray_cr');
        added -= parts.length - 1;
        keep = parts.join('');
      }
      seg = keep;
    }
    if (seg.length > 0) value = value.length === 0 ? seg : value + seg;
    if (ended === COMMA) {
      pos = end + 1;
    } else if (ended === LINE_BREAK) {
      pos = end + 1;
      line += 1;
    } else {
      pos = len;
    }
    fValue = value;
    fEnded = ended;
    fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue/fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote, skipping doubled quotes ("").
    let search = pos + 1;
    let doubled = false;
    let q = -1;
    for (;;) {
      q = text.indexOf('"', search);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        doubled = true;
        search = q + 2;
        continue;
      }
      break;
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      pushError('unterminated_quote');
      readUnquoted('"');
      return;
    }
    // The field's content is text[open + 1, q), doubled quotes collapsed
    // and every CR, LF or CRLF inside it read as one LF (and counted).
    let value;
    const content = text.slice(open + 1, q);
    if (content.indexOf('\r') === -1 && content.indexOf('\n') === -1) {
      value = doubled ? content.split('""').join('"') : content;
    } else {
      // Rare: a note spanning lines. Walk only this one field, jumping
      // between its quotes and line breaks.
      let out = '';
      let i = 0;
      const clen = content.length;
      for (;;) {
        const dIdx = content.indexOf('"', i);
        const rIdx = content.indexOf('\r', i);
        const nIdx = content.indexOf('\n', i);
        let next = -1;
        let kind = 0; // 34 quote, 13 CR, 10 LF
        if (dIdx !== -1) {
          next = dIdx;
          kind = 34;
        }
        if (rIdx !== -1 && (next === -1 || rIdx < next)) {
          next = rIdx;
          kind = 13;
        }
        if (nIdx !== -1 && (next === -1 || nIdx < next)) {
          next = nIdx;
          kind = 10;
        }
        if (next === -1) {
          out += content.slice(i);
          break;
        }
        if (next > i) out += content.slice(i, next);
        if (kind === 34) {
          // A quote inside the content is always half of a doubled pair:
          // "" reads as one quote.
          out += '"';
          i = next + 2;
        } else if (kind === 13) {
          out += '\n';
          line += 1;
          i = content.charCodeAt(next + 1) === 10 ? next + 2 : next + 1;
        } else {
          out += '\n';
          line += 1;
          i = next + 1;
        }
      }
      value = out;
    }
    pos = q + 1;
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) pushError('quote_junk');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    // Fast path: the record's first line holds no quote and no stray CR, so
    // the whole record is that line, split on commas in one native call.
    // A CR as its last character before the LF is the CRLF break itself.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const seg = text.slice(pos, lineEnd);
    const qIdx = seg.indexOf('"');
    const rIdx = seg.indexOf('\r');
    if (qIdx === -1 && (rIdx === -1 || (nl !== -1 && rIdx === seg.length - 1))) {
      const body = rIdx === seg.length - 1 ? seg.slice(0, -1) : seg;
      fields = body.split(',');
      if (nl === -1) {
        pos = len;
      } else {
        pos = nl + 1;
        line += 1;
      }
    } else {
      // Slow path: field by field, still jumping with indexOf.
      fields = [];
      let ended;
      let quoted = false;
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) readQuoted();
        else readUnquoted('');
        fields.push(fValue);
        ended = fEnded;
      } while (ended === COMMA);
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
