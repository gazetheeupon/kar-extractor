/*
 * Parser for .kar / .mid (Standard MIDI File) karaoke lyric files.
 *
 * Format background: a .kar file is an ordinary Standard MIDI File (SMF),
 * format 0 or 1, with lyrics embedded as meta-events inside the track data.
 * Two conventions exist and both appear in the wild:
 *
 *   - The modern standard: meta-event 0xFF 0x05 ("Lyric"). Each event
 *     carries one syllable/word of lyric text at the tick where it's sung.
 *
 *   - The older "Soft Karaoke" convention (the one that gave .kar its
 *     name, originated by Tune 1000 / the early hardware karaoke
 *     players): lyrics are stored as meta-event 0xFF 0x01 ("Text")
 *     instead, with two special leading characters used by convention:
 *       '/'  -> start a new line before this text
 *       '\\' -> start a new line AND a new "page" (clear the display)
 *     A dedicated first track also carries file-level metadata as Text
 *     events whose content starts with '@': "@KMIDI KARAOKE FILE" marks
 *     the file as Soft Karaoke, "@LENGL" (or similar) gives a language
 *     code, and "@Txxx" lines give title/artist/credit lines.
 *
 * This parser reads the raw SMF binary directly (chunk headers, delta-time
 * variable-length quantities, running status, meta events) rather than
 * depending on a MIDI library, decodes both lyric conventions, builds a
 * tempo map (merged across all tracks, since a conductor track's tempo
 * events apply to the whole file) to convert tick positions to real
 * seconds, and groups lyric events into display lines.
 *
 * Deliberately NOT attempted: audio synthesis / playback. No browser ships
 * a General MIDI synthesizer, and a real soundfont-based synth is a much
 * bigger engineering lift than this tool's scope. Instead this parser
 * supports a silent, timer-based lyric-sync preview (the UI advances
 * through lines using elapsed wall-clock time compared against each
 * line's computed timestamp) plus .lrc / .txt / "lyrics stripped" .mid
 * export.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KarParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class KarParseError extends Error {}

  const META_TEXT = 0x01;
  const META_COPYRIGHT = 0x02;
  const META_TRACK_NAME = 0x03;
  const META_LYRIC = 0x05;
  const META_END_OF_TRACK = 0x2f;
  const META_SET_TEMPO = 0x51;

  // ---- low-level byte reading ---------------------------------------

  function readAscii(bytes, pos, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[pos + i]);
    return s;
  }

  function readUInt32BE(bytes, pos) {
    return (bytes[pos] * 0x1000000) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3];
  }

  function readUInt16BE(bytes, pos) {
    return (bytes[pos] << 8) | bytes[pos + 1];
  }

  function readVLQ(bytes, pos) {
    let value = 0;
    let b;
    let count = 0;
    do {
      if (pos >= bytes.length) throw new KarParseError('Unexpected end of file while reading a variable-length value. The file is likely truncated or corrupted.');
      b = bytes[pos];
      pos++;
      value = (value << 7) | (b & 0x7f);
      count++;
      if (count > 5) throw new KarParseError('A variable-length value in this file is malformed (too many continuation bytes).');
    } while (b & 0x80);
    return [value >>> 0, pos];
  }

  function decodeText(bytes) {
    // MIDI text meta events are historically ASCII/Latin-1, but plenty of
    // real-world files use UTF-8. Decode leniently (never throws).
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  // ---- SMF structural parse -------------------------------------------

  function parseHeader(bytes) {
    if (bytes.length < 14 || readAscii(bytes, 0, 4) !== 'MThd') {
      throw new KarParseError('This does not look like a Standard MIDI File: no "MThd" header chunk found at the start.');
    }
    const headerLen = readUInt32BE(bytes, 4);
    const format = readUInt16BE(bytes, 8);
    const ntrks = readUInt16BE(bytes, 10);
    const divisionRaw = readUInt16BE(bytes, 12);
    if (divisionRaw & 0x8000) {
      throw new KarParseError('This MIDI file uses SMPTE time-code based timing instead of ticks-per-quarter-note. That is extremely rare for karaoke files and is not supported here.');
    }
    return { format, ntrks, ppq: divisionRaw, headerEnd: 8 + headerLen };
  }

  function parseTrackEvents(bytes) {
    const events = [];
    let pos = 0;
    let absTick = 0;
    let runningStatus = null;
    while (pos < bytes.length) {
      let deltaTicks;
      [deltaTicks, pos] = readVLQ(bytes, pos);
      absTick += deltaTicks;

      if (pos >= bytes.length) throw new KarParseError('A track ends in the middle of an event. The file is likely truncated.');
      let statusByte = bytes[pos];
      let usingRunningStatus = false;
      if (statusByte & 0x80) {
        runningStatus = statusByte;
        pos++;
      } else {
        if (runningStatus == null) throw new KarParseError('A MIDI event uses running status before any status byte has been seen. The file is malformed.');
        usingRunningStatus = true;
      }
      const status = runningStatus;

      if (status === 0xff) {
        const metaType = bytes[pos];
        pos++;
        let len;
        [len, pos] = readVLQ(bytes, pos);
        if (pos + len > bytes.length) throw new KarParseError('A meta-event\'s declared length runs past the end of the track. The file is likely truncated.');
        const data = bytes.slice(pos, pos + len);
        pos += len;
        events.push({ absTick, deltaTicks, type: 'meta', metaType, data });
      } else if (status === 0xf0 || status === 0xf7) {
        let len;
        [len, pos] = readVLQ(bytes, pos);
        if (pos + len > bytes.length) throw new KarParseError('A sysex event\'s declared length runs past the end of the track. The file is likely truncated.');
        const data = bytes.slice(pos, pos + len);
        pos += len;
        events.push({ absTick, deltaTicks, type: 'sysex', statusByte: status, data });
      } else if ((status & 0xf0) >= 0x80 && (status & 0xf0) <= 0xe0) {
        const hi = status & 0xf0;
        const dataLen = (hi === 0xc0 || hi === 0xd0) ? 1 : 2;
        if (pos + dataLen > bytes.length) throw new KarParseError('A MIDI channel event runs past the end of the track. The file is likely truncated.');
        const data1 = bytes[pos];
        pos += 1;
        let data2;
        if (dataLen === 2) {
          data2 = bytes[pos];
          pos += 1;
        }
        events.push({ absTick, deltaTicks, type: 'channel', status, data1, data2, dataLen });
      } else {
        // Rare system-common messages (song position, song select, tune
        // request, ...). Not meaningful for lyric extraction, but must be
        // consumed with the right byte count so parsing doesn't derail.
        const sysCommonLen = { 0xf1: 1, 0xf2: 2, 0xf3: 1, 0xf4: 0, 0xf5: 0, 0xf6: 0 };
        const len = sysCommonLen[status];
        if (len === undefined) {
          throw new KarParseError(`Unrecognized MIDI status byte 0x${status.toString(16)} in this track. The file may be corrupted.`);
        }
        if (pos + len > bytes.length) throw new KarParseError('A system message runs past the end of the track. The file is likely truncated.');
        pos += len;
        events.push({ absTick, deltaTicks, type: 'system', statusByte: status });
      }
      void usingRunningStatus;
    }
    return events;
  }

  function parseChunks(bytes) {
    const header = parseHeader(bytes);
    let pos = header.headerEnd;
    const tracks = [];
    let tracksFound = 0;
    while (pos < bytes.length && tracksFound < header.ntrks) {
      if (pos + 8 > bytes.length) throw new KarParseError('The file ends before all declared tracks were found. It is likely truncated.');
      const chunkId = readAscii(bytes, pos, 4);
      const chunkLen = readUInt32BE(bytes, pos + 4);
      pos += 8;
      if (pos + chunkLen > bytes.length) throw new KarParseError(`A "${chunkId}" chunk declares a length that runs past the end of the file. It is likely truncated.`);
      if (chunkId === 'MTrk') {
        const trackBytes = bytes.slice(pos, pos + chunkLen);
        tracks.push(parseTrackEvents(trackBytes));
        tracksFound++;
      }
      // Unknown chunk types are skipped per the SMF spec (readers must
      // tolerate chunks they don't recognize).
      pos += chunkLen;
    }
    if (tracksFound < header.ntrks) {
      throw new KarParseError(`This file declares ${header.ntrks} track(s) but only ${tracksFound} were found before the file ended.`);
    }
    return { format: header.format, ppq: header.ppq, tracks };
  }

  // ---- tempo map / tick-to-seconds -------------------------------------

  function buildTempoSegments(tracks, ppq) {
    const changes = [];
    for (const track of tracks) {
      for (const ev of track) {
        if (ev.type === 'meta' && ev.metaType === META_SET_TEMPO && ev.data.length >= 3) {
          const usPerQuarter = (ev.data[0] << 16) | (ev.data[1] << 8) | ev.data[2];
          changes.push({ tick: ev.absTick, usPerQuarter });
        }
      }
    }
    changes.sort((a, b) => a.tick - b.tick);
    if (changes.length === 0 || changes[0].tick !== 0) {
      changes.unshift({ tick: 0, usPerQuarter: 500000 }); // default 120 BPM
    }
    // De-duplicate same-tick entries, keeping the last one declared at
    // that tick (matches playback semantics: later events override).
    const deduped = [];
    for (const c of changes) {
      if (deduped.length && deduped[deduped.length - 1].tick === c.tick) {
        deduped[deduped.length - 1] = c;
      } else {
        deduped.push(c);
      }
    }
    let cumSeconds = 0;
    const segments = [];
    for (let i = 0; i < deduped.length; i++) {
      segments.push({ tick: deduped[i].tick, cumSeconds, usPerQuarter: deduped[i].usPerQuarter });
      const nextTick = i + 1 < deduped.length ? deduped[i + 1].tick : null;
      if (nextTick != null) {
        const ticks = nextTick - deduped[i].tick;
        cumSeconds += (ticks / ppq) * (deduped[i].usPerQuarter / 1e6);
      }
    }
    return segments;
  }

  function makeTickToSeconds(segments, ppq) {
    return function tickToSeconds(tick) {
      let seg = segments[0];
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].tick <= tick) seg = segments[i];
        else break;
      }
      const ticksIntoSeg = tick - seg.tick;
      return seg.cumSeconds + (ticksIntoSeg / ppq) * (seg.usPerQuarter / 1e6);
    };
  }

  // ---- lyric / metadata extraction -------------------------------------

  function classifyTextEvent(text) {
    if (text.startsWith('@')) return { isMetadata: true };
    if (text.startsWith('/')) return { isMetadata: false, lineBreak: true, newPage: false, displayText: text.slice(1) };
    if (text.startsWith('\\')) return { isMetadata: false, lineBreak: true, newPage: true, displayText: text.slice(1) };
    return { isMetadata: false, lineBreak: false, newPage: false, displayText: text };
  }

  function extractMetadata(text, metadata) {
    if (text.startsWith('@L')) {
      metadata.language = text.slice(2).trim() || metadata.language;
    } else if (text.startsWith('@T')) {
      metadata.titleLines.push(text.slice(2));
    } else if (/^@KMIDI\s+KARAOKE\s+FILE/i.test(text)) {
      metadata.isKarFile = true;
    } else {
      metadata.other.push(text);
    }
  }

  function extractLyricsAndMetadata(tracks, tickToSeconds) {
    const raw = [];
    const metadata = { isKarFile: false, language: null, titleLines: [], other: [] };
    const trackNames = [];
    let copyright = null;

    for (const track of tracks) {
      for (const ev of track) {
        if (ev.type !== 'meta') continue;
        if (ev.metaType === META_TRACK_NAME) {
          const name = decodeText(ev.data).trim();
          if (name) trackNames.push(name);
        } else if (ev.metaType === META_COPYRIGHT) {
          copyright = decodeText(ev.data).trim();
        } else if (ev.metaType === META_LYRIC) {
          const text = decodeText(ev.data);
          // Some modern lyric-event files embed an explicit newline in the
          // text itself rather than using the Soft Karaoke '/'+'\\' prefix
          // convention; honor a single embedded newline as a line break.
          const nlIndex = text.indexOf('\n');
          if (nlIndex === -1) {
            raw.push({ tick: ev.absTick, source: 'lyric', lineBreak: false, newPage: false, displayText: text });
          } else {
            raw.push({ tick: ev.absTick, source: 'lyric', lineBreak: false, newPage: false, displayText: text.slice(0, nlIndex) });
            raw.push({ tick: ev.absTick, source: 'lyric', lineBreak: true, newPage: false, displayText: text.slice(nlIndex + 1) });
          }
        } else if (ev.metaType === META_TEXT) {
          const text = decodeText(ev.data);
          const cls = classifyTextEvent(text);
          if (cls.isMetadata) {
            extractMetadata(text, metadata);
          } else {
            raw.push({ tick: ev.absTick, source: 'text', lineBreak: cls.lineBreak, newPage: cls.newPage, displayText: cls.displayText });
          }
        }
      }
    }

    raw.sort((a, b) => a.tick - b.tick);
    const lyricEvents = raw.map((e) => ({ ...e, seconds: tickToSeconds(e.tick) }));

    // Group into display lines. A gap of more than 1.5s between two
    // consecutive lyric-sourced events (files with no explicit line-break
    // markers at all) is treated as an implicit line break, so a plain
    // lyric-only file doesn't collapse into one unbroken wall of text.
    const lines = [];
    let current = null;
    let prevEnd = null;
    for (const ev of lyricEvents) {
      const impliedBreak = prevEnd != null && (ev.seconds - prevEnd) > 1.5;
      if (current === null || ev.lineBreak || impliedBreak) {
        current = { tick: ev.tick, seconds: ev.seconds, text: '', newPage: ev.newPage };
        lines.push(current);
      }
      current.text += ev.displayText;
      prevEnd = ev.seconds;
    }

    return { lyricEvents, lines, metadata, trackNames, copyright };
  }

  // ---- top-level parse --------------------------------------------------

  function parseMidiBuffer(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const { format, ppq, tracks } = parseChunks(bytes);

    const tempoSegments = buildTempoSegments(tracks, ppq);
    const tickToSeconds = makeTickToSeconds(tempoSegments, ppq);

    const { lyricEvents, lines, metadata, trackNames, copyright } = extractLyricsAndMetadata(tracks, tickToSeconds);

    let maxTick = 0;
    for (const track of tracks) {
      for (const ev of track) {
        if (ev.absTick > maxTick) maxTick = ev.absTick;
      }
    }
    const durationSeconds = tickToSeconds(maxTick);

    const warnings = [];
    if (lyricEvents.length === 0) {
      warnings.push('No lyric or text meta-events were found in this file. It may be an instrumental MIDI file rather than a karaoke (.kar) file.');
    }

    return {
      format,
      ppq,
      trackCount: tracks.length,
      durationSeconds,
      tempoSegments,
      lyricEvents,
      lines,
      metadata,
      trackNames,
      copyright,
      warnings,
      _tracks: tracks, // retained internally for export (strip-lyrics re-serialization)
    };
  }

  // ---- formatting helpers -------------------------------------------------

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  }

  function toLrc(parsed) {
    const out = [];
    if (parsed.metadata.titleLines[0]) out.push(`[ti:${parsed.metadata.titleLines[0]}]`);
    if (parsed.metadata.titleLines[1]) out.push(`[ar:${parsed.metadata.titleLines[1]}]`);
    for (const line of parsed.lines) {
      const m = Math.floor(line.seconds / 60);
      const s = line.seconds - m * 60;
      const tag = `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]`;
      out.push(tag + line.text.trim());
    }
    return out.join('\n') + '\n';
  }

  function toPlainText(parsed) {
    return parsed.lines.map((l) => l.text.trim()).join('\n') + '\n';
  }

  // ---- "clean" MIDI export: strip Text(0x01)/Lyric(0x05) meta-events -----

  function encodeVLQ(value) {
    const stack = [value & 0x7f];
    value = value >>> 7;
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value = value >>> 7;
    }
    return stack;
  }

  function writeUInt32BE(arr, value) {
    arr.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  function writeUInt16BE(arr, value) {
    arr.push((value >>> 8) & 0xff, value & 0xff);
  }

  function encodeEvent(ev) {
    const bytes = [];
    if (ev.type === 'meta') {
      bytes.push(0xff, ev.metaType, ...encodeVLQ(ev.data.length), ...ev.data);
    } else if (ev.type === 'sysex') {
      bytes.push(ev.statusByte, ...encodeVLQ(ev.data.length), ...ev.data);
    } else if (ev.type === 'channel') {
      bytes.push(ev.status, ev.data1);
      if (ev.dataLen === 2) bytes.push(ev.data2);
    } else if (ev.type === 'system') {
      bytes.push(ev.statusByte);
    }
    return bytes;
  }

  function stripLyricsToBuffer(parsed) {
    const out = [];
    out.push(0x4d, 0x54, 0x68, 0x64); // "MThd"
    writeUInt32BE(out, 6);
    writeUInt16BE(out, parsed.format);
    writeUInt16BE(out, parsed._tracks.length);
    writeUInt16BE(out, parsed.ppq);

    for (const track of parsed._tracks) {
      const kept = track.filter((ev) => !(ev.type === 'meta' && (ev.metaType === META_TEXT || ev.metaType === META_LYRIC)));
      // Recompute deltas so absolute tick positions of surviving events
      // are preserved exactly.
      let prevTick = 0;
      const trackBytes = [];
      for (const ev of kept) {
        const deltaTicks = ev.absTick - prevTick;
        prevTick = ev.absTick;
        trackBytes.push(...encodeVLQ(deltaTicks), ...encodeEvent(ev));
      }
      const hasEndOfTrack = kept.length && kept[kept.length - 1].type === 'meta' && kept[kept.length - 1].metaType === META_END_OF_TRACK;
      if (!hasEndOfTrack) {
        trackBytes.push(...encodeVLQ(0), 0xff, META_END_OF_TRACK, 0x00);
      }
      out.push(0x4d, 0x54, 0x72, 0x6b); // "MTrk"
      writeUInt32BE(out, trackBytes.length);
      out.push(...trackBytes);
    }

    return new Uint8Array(out).buffer;
  }

  return {
    KarParseError,
    parseMidiBuffer,
    formatTime,
    toLrc,
    toPlainText,
    stripLyricsToBuffer,
    _internal: { readVLQ, encodeVLQ, buildTempoSegments, makeTickToSeconds, classifyTextEvent, extractMetadata },
  };
});
