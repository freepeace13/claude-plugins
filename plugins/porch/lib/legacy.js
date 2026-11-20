'use strict';
// `porch import`: bring 0.1.0 work folders (<project>/.porch/<slug>/ with brief.md, draft.md, review.md) into the store.

const fs = require('fs');
const path = require('path');
const { has, now, expandHome, frontmatter } = require('./util');
const store = require('./store');

/** Check every folder before anything is created, so a bad one later in the list leaves nothing half done. */
function plan(srcs) {
  if (!srcs.length) throw new Error('usage: porch import <project>/.porch/<slug>… [--json]');
  return srcs.map((src) => {
    let abs;
    try { abs = fs.realpathSync(path.resolve(expandHome(src))); } catch { throw new Error(`no such folder: ${src}`); }
    if (!fs.statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`);
    const brief = frontmatter(path.join(abs, 'brief.md'));
    const draft = frontmatter(path.join(abs, 'draft.md'));
    if (!brief && !draft) throw new Error(`${abs} has no brief.md or draft.md; is it a .porch/<slug> folder?`);
    const type = (brief && brief.type) || (draft && draft.type);
    if (!has(store.TYPES, type)) throw new Error(`${abs}: type must be article or case-study, got "${type || ''}"`);
    return { abs, brief, draft, type };
  });
}

/** Import one planned folder. Returns { skipped: existing } when it was imported before, else { work, approved }. */
function importOne({ abs, brief, draft, type }) {
  const dup = store.all().find((w) => w.state.source === abs);
  if (dup) return { abs, skipped: dup };

  const slug = (brief && brief.slug) || (draft && draft.slug) || path.basename(abs);
  let review = '';
  try { review = fs.readFileSync(path.join(abs, 'review.md'), 'utf8'); } catch { /* none */ }
  const approved = /(^|\n)\s*approved\s*$/.test(review);
  // Approved: the files stay at the root so /porch:push works. Otherwise they become the intake
  // of a new work folder, which /porch:brief <id> checks and briefs again.
  const work = store.createWork(type, (staging, id) => {
    const target = approved ? staging : path.join(staging, 'intake', path.basename(abs));
    fs.mkdirSync(target, { recursive: true });
    for (const f of ['brief.md', 'draft.md', 'review.md']) {
      if (fs.existsSync(path.join(abs, f))) fs.copyFileSync(path.join(abs, f), path.join(target, f));
    }
    const t = now();
    return {
      id,
      type,
      status: approved ? 'approved' : 'new',
      title: (draft && draft.title) || slug,
      topic: (brief && brief.thesis) || (draft && draft.title) || slug,
      slug: store.SLUG.test(slug) ? slug : '',
      tags: [],
      kind: null,
      note: 'imported from porch 0.1.0',
      source: abs,
      intake: approved ? null : `intake/${path.basename(abs)}`,
      porch_id: null,
      created_at: t,
      updated_at: t,
    };
  });
  return { abs, work, approved };
}

/** A project's .porch/voice.md next to an imported folder, which the store no longer reads. */
function oldVoice(abs) {
  const voice = path.join(path.dirname(abs), 'voice.md');
  return path.basename(path.dirname(abs)) === '.porch' && fs.existsSync(voice) ? voice : null;
}

module.exports = { plan, importOne, oldVoice };
