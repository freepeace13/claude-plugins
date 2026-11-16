'use strict';
// Batch-delete filters for `delete`.

const { parseAge } = require('./util');
const store = require('./store');

const isWritten = (log) => Array.isArray(log.meta.written_to) && log.meta.written_to.length > 0;

/** Batch-delete filters. At least one filter is required so nothing is wiped by accident. */
function filterLogs(opts) {
  const keys = ['project', 'belowScore', 'olderThan', 'unmarked', 'written', 'unwritten'];
  if (!keys.some((k) => opts[k] !== undefined && opts[k] !== false)) {
    throw new Error('Batch delete needs at least one filter: --project, --below-score, --older-than, --unmarked, --written or --unwritten');
  }
  const before = opts.olderThan ? parseAge(opts.olderThan) : null;
  return store.allLogs(opts.project).filter((log) => {
    const m = log.meta;
    if (opts.belowScore !== undefined && !((m.score || 0) < Number(opts.belowScore))) return false;
    if (before && !(new Date(m.created_at || m.started_at) < before)) return false;
    if (opts.unmarked && m.marked) return false;
    if (opts.written && !isWritten(log)) return false;
    if (opts.unwritten && isWritten(log)) return false;
    return true;
  });
}

module.exports = { filterLogs, isWritten };
