# Voice questions

`/porch:voice` asks these 16 questions to capture how the author writes. Each one turns a trait of a good speaker into its equivalent on the page. Every option has a preview, which is the same short passage written in that style, so the author picks by ear instead of by label. Each option also has the rule it writes into `voice.md`. The previews are samples: their content is invented.

Each question has an id (the key in `voice.md`'s `answers`), an area, the `header` chip (at most 12 characters) and the question text. Each option has an id, a label (shown as the choice), a description, a preview and a rule. When the author picks "Other", their own words become the rule (see the skill).

Areas, in the order they appear in `voice.md`:

| Area | Heading in voice.md | Questions |
|---|---|---|
| Vocal characteristics | Rhythm | rhythm, pauses, pace, stance, words |
| Body language and stage presence | Presence | reader, candor, emoji, mood |
| Content and delivery style | Delivery | layout, openings, register, format, ending |
| Audience engagement and adaptability | Audience | depth, pressure |

## Vocal characteristics

### Q1 `rhythm`: vocal variety

- header: `1/16 Rhythm`
- question: How do your sentences move?

#### `even` Short and even
- description: One idea per sentence, all about the same length.
- preview:
  > The test suite took 14 minutes. Most of it was one fixture. I cached it. Now it takes 3.
- rule: Keep sentences short and close in length. One idea per sentence.

#### `punch` Mostly short
- description: Mostly short. A longer sentence when a chain of cause and effect needs it.
- preview:
  > The test suite took 14 minutes. Most of that went into one fixture that rebuilt the whole database for every file, even files that never touched it. I cached it. Now it takes 3.
- rule: Default to short sentences. Use a longer one when it carries a chain of cause and effect, then go back to short.

#### `build` Long build-up, short landing
- description: Varied on purpose. The setup runs long and the point lands short.
- preview:
  > For months we treated the 14-minute test run like the weather: something you complain about, plan around and never question. Then I profiled it. One fixture. It runs in 3 now.
- rule: Vary sentence length on purpose. Let a long sentence build the setup, then land the point in a short one.

#### `flow` Long and flowing
- description: Connected sentences that carry the reasoning in one breath.
- preview:
  > The test suite had crept up to 14 minutes over the year, and when I finally profiled it, most of that time turned out to be one fixture rebuilding the database for every file, so caching it brought the run down to 3.
- rule: Longer, connected sentences are fine. Join cause and effect with "so", "because" and "which" instead of splitting every clause.

### Q2 `pauses`: strategic pauses

- header: `2/16 Pauses`
- question: How do you make a key point land?

#### `none` Let the sentence do it
- description: No dramatic breaks. The words carry the weight.
- preview:
  > Caching the fixture cut the run from 14 minutes to 3, which was the only change that mattered.
- rule: No one-line paragraphs or dramatic breaks. Let the sentence carry the point.

#### `oneline` A one-line paragraph
- description: Now and then, the key point stands alone.
- preview:
  > I tried parallel workers, a faster runner and a bigger CI machine. Each one shaved a minute.
  >
  > The fixture was the whole problem.
- rule: Land a section's key point in a one-line paragraph, at most twice per piece.

#### `dash` A dash or colon first
- description: A beat before the payoff, inside the sentence.
- preview:
  > I tried three fixes before profiling. The answer was the one thing I hadn't looked at: the fixture.
- rule: Set up a payoff with a colon or a dash before it, at most once per section.

#### `aside` A quick aside
- description: The thought a speaker would say under their breath, in brackets.
- preview:
  > I tried three fixes before profiling (in hindsight, the wrong order). The fixture was the problem.
- rule: Use short bracketed asides for the thought a speaker would say under their breath. One clause each, at most one per paragraph.

### Q3 `pace`: controlled pacing

- header: `3/16 Pace`
- question: How quickly do you get to the point?

#### `first` First sentence
- description: The point comes first, then the evidence.
- preview:
  > Cache your heaviest fixture before you parallelise anything. Here is how that took a test run from 14 minutes to 3.
- rule: State the point in the first sentence, then back it up.

#### `setup` After a little context
- description: One or two sentences of context, then the point.
- preview:
  > Our test run had crept up to 14 minutes. Everyone blamed the CI machine. The real cause was one fixture.
- rule: Give one or two sentences of context, then state the point.

#### `scene` After a short scene
- description: Open on a moment, reach the point by the second paragraph.
- preview:
  > It was the third time that week I'd pushed a one-line fix and gone to make coffee while CI ran.
  >
  > The run took 14 minutes, and most of it was one fixture.
- rule: Open with a short scene of one paragraph at most, and state the point in the second paragraph.

#### `question` With the question
- description: Open with the question the piece answers.
- preview:
  > Why does a test suite with 400 tests take 14 minutes? In our case, one fixture.
- rule: Open with the question the piece answers, and answer it within the first two paragraphs.

### Q4 `stance`: projection and enunciation (confidence)

- header: `4/16 Stance`
- question: How sure do you sound?

#### `flat` Plain statements
- description: Say it as it is. No qualifiers.
- preview:
  > The fixture was the bottleneck. Caching it fixed the run.
- rule: State claims plainly, without qualifiers.

#### `reasoned` Sure, with reasons
- description: Assert, and qualify only when there is a reason, which you name.
- preview:
  > The fixture was the bottleneck. Caching it is safe here because no test writes to those tables. If yours do, it isn't.
- rule: Assert claims. Qualify one only when there is a real condition, and name the condition.

#### `thinking` Thinking out loud
- description: Show the doubts you had at the time, and what you still don't know.
- preview:
  > I wasn't sure caching would hold. Some tests might write to those tables, and I still haven't checked all of them.
- rule: Show the reasoning as it happened, including doubts at the time. Say plainly what you still don't know, without apologising.

#### `strong` Strong opinions
- description: Direct advice, in the imperative.
- preview:
  > Don't parallelise a slow suite. Profile it. The fix is almost never more machines.
- rule: Give advice in the imperative and state opinions as opinions, without softening them.

### Q5 `words`: enunciation (word choice)

- header: `5/16 Words`
- question: How technical are your words?

#### `plain` Plain words
- description: Everyday words. Any term a newcomer wouldn't know is explained the first time.
- preview:
  > A fixture is the data a test starts from. Ours rebuilt the whole database before every test file.
- rule: Prefer everyday words. Explain any term a newcomer wouldn't know the first time it appears.

#### `peer` The field's terms
- description: Use the jargon your peers use, without explaining it.
- preview:
  > The DB fixture ran a full migrate:fresh per test file instead of wrapping each test in a transaction.
- rule: Use the field's terms without explaining them.

#### `gloss` Precise term, quick gloss
- description: The exact term, with a few words of explanation in passing.
- preview:
  > The fixture ran migrate:fresh, a full rebuild of the schema, before every test file.
- rule: Use the precise term, with a few words of explanation in passing the first time it appears.

## Body language and stage presence

### Q6 `reader`: intentional eye contact

- header: `6/16 Reader`
- question: How do you speak to the reader?

#### `none` I tell, not address
- description: Tell what I did and why. No "you".
- preview:
  > I profiled the suite before changing anything. The fixture stood out at once.
- rule: Don't address the reader. Tell what you did and why.

#### `advice` "You" for advice
- description: Speak to the reader only when giving advice or a step.
- preview:
  > I profiled the suite before changing anything. If your run is slow, do that first.
- rule: Address the reader as "you" only when giving advice or a step they would take.

#### `direct` Across the table
- description: Talk to the reader throughout, as if they're sitting with you.
- preview:
  > You know the feeling: you push a one-line fix and wait 14 minutes. Here's what I found when I finally looked.
- rule: Talk to the reader directly throughout, as if they are across the table.

#### `we` "We", working together
- description: Walk through the reasoning together. "I" stays for what you did.
- preview:
  > If we look at the profile, one fixture takes most of the run. So I cached it.
- rule: Use an inclusive "we" when walking through reasoning the reader can follow. Keep "I" for what you did.

### Q7 `candor`: open posture

- header: `7/16 Candor`
- question: How open are you about your mistakes?

#### `plain` Name them plainly
- description: Say what went wrong and what it cost.
- preview:
  > I added parallel workers first. It made the run flaky and cost me two days.
- rule: Name your mistakes plainly, with what they cost.

#### `relevant` When it matters
- description: Mention a mistake when the story needs it.
- preview:
  > Parallel workers didn't help, which is what sent me to the profiler.
- rule: Mention a mistake when the story turns on it. Otherwise leave it out.

#### `wry` With a wry smile
- description: Own it with some self-deprecating humour.
- preview:
  > My first fix was to throw more workers at it. Two flaky days later, I opened the profiler like I should have on day one.
- rule: Own your mistakes with light, self-deprecating humour. Keep the joke to one line.

#### `brief` Brief, then the fix
- description: Professional. A mistake is one sentence, then on to the fix.
- preview:
  > An early attempt with parallel workers made the run flaky. Profiling showed the real cause.
- rule: Mention a mistake in one sentence as the cause of the fix, then move on.

### Q8 `emoji`: natural gestures

- header: `8/16 Emoji`
- question: Do you use emoji?

#### `never` Never
- description: No emoji anywhere.
- preview:
  > Caching the fixture worked. The run takes 3 minutes now.
- rule: No emoji anywhere.

#### `markers` As markers only
- description: Status markers at the start of a list item, never inside a sentence.
- preview:
  > - ✅ Cache the fixture
  > - ❌ Add more workers
- rule: Use emoji only as status markers at the start of a list item (✅, ❌, ⚠️). Never inside a sentence.

#### `tone` Now and then, for tone
- description: An emoji may close a sentence to show how you feel.
- preview:
  > Caching the fixture worked. The run takes 3 minutes now 🎉
- rule: An emoji may close a sentence to show tone, at most 3 per piece.

#### `freely` Freely
- description: Emoji wherever they fit the mood.
- preview:
  > 🐢 14 minutes per run. 🔍 One profile later: the fixture. ⚡ 3 minutes now.
- rule: Use emoji freely to show tone and mark points.

### Q9 `mood`: expressive facial cues

- header: `9/16 Mood`
- question: How much feeling shows in your writing?

#### `even` Even-toned
- description: Feelings stay out. The facts carry it.
- preview:
  > The run went from 14 minutes to 3.
- rule: Keep an even tone. Let the facts carry the feeling.

#### `dry` Dry wit
- description: An occasional dry remark.
- preview:
  > The run went from 14 minutes to 3. The coffee machine misses me.
- rule: Allow an occasional dry remark, at most one per section.

#### `warm` Warm and playful
- description: Show the fun and the frustration.
- preview:
  > Watching the run finish in 3 minutes for the first time felt ridiculous, in the best way.
- rule: Let warmth and playfulness show, including frustration and relief.

#### `excited` Enthusiastic
- description: Show excitement when something works. Exclamation marks allowed.
- preview:
  > Three minutes! From fourteen! I reran it twice to be sure.
- rule: Show excitement when something works. An exclamation mark is fine, at most one per section.

## Content and delivery style

### Q10 `layout`: clear structure

- header: `10/16 Layout`
- question: How do you lay a piece out?

#### `skim` Built for skimming
- description: The opening paragraph sums it up. A heading every few paragraphs.
- preview:
  > Caching one fixture took our test run from 14 minutes to 3. Here's how I found it.
  >
  > ## The symptom
  > ## The profile
  > ## The fix
- rule: Make the opening paragraph sum up the whole piece, and break sections so a skimmer can follow the headings alone.

#### `story` One story
- description: Few headings. It reads straight through.
- preview:
  > ...and that was when I opened the profiler.
  >
  > The first thing it showed was the fixture.
- rule: Use only the outline's headings, no extra subheadings, and join sections with a linking sentence.

#### `steps` Steps where there's a sequence
- description: Numbered steps whenever the reader would follow along.
- preview:
  > 1. Profile the run.
  > 2. Find the slowest fixture.
  > 3. Cache it, and check no test writes to it.
- rule: Write any sequence the reader would follow as a numbered list.

### Q11 `openings`: storytelling and concrete examples

- header: `11/16 Opens`
- question: How do you bring in an idea?

#### `story` With what happened
- description: The event first, the lesson after.
- preview:
  > Last spring our test run hit 14 minutes. I profiled it and found one fixture doing most of the work.
- rule: Bring in each idea with what happened, then draw the lesson from it.

#### `principle` Principle, then example
- description: The idea first, then the case that shows it.
- preview:
  > Slow suites are usually one slow thing. Ours was a fixture that took 11 of its 14 minutes.
- rule: State each idea first, then show it with a concrete case.

#### `code` With the code
- description: Show the code or the output, then explain it.
- preview:
  > ```bash
  > $ pest --profile
  > DatabaseFixture  11m 02s
  > ```
  > One fixture, 11 minutes.
- rule: Bring in each idea with the code or output that shows it, then explain it.

#### `contrast` Before and after
- description: Show the two states side by side.
- preview:
  > Before: 14 minutes, a database rebuilt per file. After: 3 minutes, built once and cached.
- rule: Bring in each idea by contrasting before and after.

### Q12 `register`: conversational authenticity

- header: `12/16 Tone`
- question: How formal is your writing?

#### `casual` Like talking to a teammate
- description: Contractions, asides, the odd "honestly".
- preview:
  > Honestly, I'd ignored it for months. It's the kind of thing you stop seeing.
- rule: Write like you'd talk to a teammate: contractions, asides and everyday phrasing are fine.

#### `neutral` Relaxed, no slang
- description: Contractions, but nothing chatty.
- preview:
  > I'd ignored it for months. It's easy to stop noticing a slow build.
- rule: Use contractions, but keep phrasing neutral, with no slang or chatty asides.

#### `formal` Measured
- description: No contractions. Careful and even.
- preview:
  > I had ignored it for months. It is easy to stop noticing a slow build.
- rule: Do not use contractions. Keep the phrasing measured.

### Q13 `format`: visual restraint

- header: `13/16 Format`
- question: How much formatting do you use?

#### `prose` Prose first
- description: Paragraphs, with code blocks only when needed.
- preview:
  > I profiled the run, found the fixture and cached it. The change was four lines.
- rule: Write in paragraphs. Use a code block only when the code is the point. No bold, and no lists unless the outline needs one.

#### `lists` Prose and the odd list
- description: Mostly paragraphs, a list when items really are a list.
- preview:
  > Three things didn't help:
  > - more workers
  > - a faster runner
  > - a bigger machine
- rule: Write mostly in paragraphs. Use a list only when the items really are a list.

#### `skim` Bold and lists
- description: Bold the key phrases and use lists so it skims well.
- preview:
  > The fix was **caching the fixture**, not adding machines.
- rule: Bold the key phrase of a section, at most once per section, and use lists for anything with three or more items.

#### `rich` Tables when they help
- description: Tables and blockquotes when comparing or calling something out.
- preview:
  > | Fix | Run time |
  > |---|---|
  > | More workers | 13 min |
  > | Cached fixture | 3 min |
- rule: Use a table to compare options or results, and a blockquote to call out a warning.

### Q14 `ending`: clear structure (the close)

- header: `14/16 Ending`
- question: How do you end a piece?

#### `stop` Stop at the last point
- description: When it's said, it's done.
- preview:
  > ...and the run has stayed at 3 minutes since.
- rule: End on the last point. No closing line.

#### `takeaway` One line to keep
- description: The one sentence the reader should remember. Not a summary.
- preview:
  > Profile before you parallelise.
- rule: End with one sentence the reader should keep. It must not summarise the sections.

#### `next` What's next
- description: What you'd do next, or what is still open.
- preview:
  > Next I want to split the fixture so the tests that need only users don't build the rest.
- rule: End with what you would do next or what is still open, in one or two sentences.

#### `invite` An invitation
- description: A question to the reader, or an invitation to share.
- preview:
  > What's the slowest fixture in your suite? I'd bet it's older than you think.
- rule: End with a question or an invitation to the reader, in one sentence.

## Audience engagement and adaptability

### Q15 `depth`: active reading of the room

- header: `15/16 Depth`
- question: How much do you assume your reader knows?

#### `brief` Match the brief's reader
- description: Explain only what the reader named in the brief wouldn't know.
- preview:
  > (For backend engineers) The fixture ran migrate:fresh per file.
  > (For newcomers) The fixture rebuilt the database, every table from scratch, before each test file.
- rule: Match depth to the brief's reader. Explain only what that reader wouldn't know.

#### `newcomer` From the ground up
- description: Explain the basics so anyone can follow.
- preview:
  > Tests need data to start from. That data is called a fixture, and ours was rebuilt before every file.
- rule: Write so a newcomer can follow. Explain the basics before the specifics.

#### `working` A working developer
- description: Skip the basics, explain the specifics.
- preview:
  > The fixture ran a full migration per test file. That's fine for 10 files. We had 400.
- rule: Assume a working developer. Skip the basics and explain what is specific to this case.

#### `senior` A senior peer
- description: Straight to the hard part.
- preview:
  > Per-file migrate:fresh was the cost. Transactions weren't an option because of the queue tests.
- rule: Assume a senior peer. Go straight to the hard part and the trade-offs.

### Q16 `pressure`: composure under pressure

- header: `16/16 Stress`
- question: How do you tell a failure or an incident?

#### `calm` A calm timeline
- description: What broke, what I did, what changed. No drama.
- preview:
  > At 14:10 the deploy went out. By 14:20 the queue had backed up. I rolled back at 14:25.
- rule: Tell failures as a calm timeline: what broke, what you did, what changed.

#### `candid` Candid, with feeling
- description: Including how it felt at the time.
- preview:
  > The queue backed up ten minutes after the deploy, and my stomach dropped. I rolled back.
- rule: Tell failures candidly, including how they felt at the time, in a sentence or two, then get back to what you did.

#### `blameless` Blameless
- description: Systems, not people. What the system allowed and what changed.
- preview:
  > The deploy process let a migration run before the workers drained. We changed the order.
- rule: Tell failures blamelessly: describe what the system allowed and what changed, never who was at fault.

#### `light` Light, once it's fixed
- description: Some humour, looking back from safety.
- preview:
  > For ten minutes the queue was the busiest thing in the building, including me. Then I rolled back.
- rule: Allow some lightness when telling a failure that is fixed, in one line, without making light of its impact.
