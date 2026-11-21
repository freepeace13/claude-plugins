'use strict';
// Batch-delete filters for `delete`.

const { parseAge } = require('./util');
const store = require('./store');

/** Batch-delete filters. At least one filter is required so nothing is wiped by accident. */
function filterLogs(opts) {
  const keys = ['project', 'belowScore', 'olderThan', 'unmarked'];
  if (!keys.some((k) => opts[k] !== undefined && opts[k] !== false)) {
    throw new Error('Batch delete needs at least one filter: --project, --below-score, --older-than or --unmarked');
  }
  const before = opts.olderThan ? parseAge(opts.olderThan) : null;
  return store.allLogs(opts.project).filter((log) => {
    const m = log.meta;
    if (opts.belowScore !== undefined && !((m.score || 0) < Number(opts.belowScore))) return false;
    if (before && !(new Date(m.created_at || m.started_at) < before)) return false;
    if (opts.unmarked && m.marked) return false;
    return true;
  });
}

module.exports = { filterLogs };
