import crypto from "crypto";

// ---------------------------------------------------------------------
// SM-2 spaced repetition
// ---------------------------------------------------------------------
// Classic SuperMemo-2 algorithm, adapted to a 4-button "again / hard /
// good / easy" rating instead of the original 0-5 grade, the way most
// modern flashcard apps (Anki-style) present it.
//
// Rating -> SM-2 grade mapping:
//   again -> 0   (complete blackout, restart the card)
//   hard  -> 3   (recalled, but it was a struggle)
//   good  -> 4   (recalled correctly, some effort)
//   easy  -> 5   (recalled effortlessly)
const RATING_TO_GRADE = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5
};

export const VALID_RATINGS = Object.keys(RATING_TO_GRADE);

const clampEase = (ease) => Math.max(1.3, ease);

/**
 * Given a card's current SM-2 state and a rating, compute its next state.
 * All inputs/outputs are plain numbers/dates — no external calls.
 *
 * @param {{ easeFactor: number, intervalDays: number, repetitions: number }} card
 * @param {"again"|"hard"|"good"|"easy"} rating
 * @param {Date} now
 */
export const scheduleNextReview = (card, rating, now = new Date()) => {
  const grade = RATING_TO_GRADE[rating];

  if (grade === undefined) {
    throw new Error(`Invalid rating "${rating}". Expected one of: ${VALID_RATINGS.join(", ")}.`);
  }

  const currentEase = Number.isFinite(card.easeFactor) ? card.easeFactor : 2.5;
  const currentRepetitions = Number.isFinite(card.repetitions) ? card.repetitions : 0;

  // A failed recall ("again") always resets the learning progress,
  // regardless of prior streak, and comes back for review soon.
  if (grade < 3) {
    return {
      easeFactor: clampEase(currentEase - 0.2),
      intervalDays: 0,
      repetitions: 0,
      dueDate: addMinutes(now, 1)
    };
  }

  const nextRepetitions = currentRepetitions + 1;
  const nextEase = clampEase(
    currentEase + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))
  );

  let nextInterval;
  if (nextRepetitions === 1) {
    nextInterval = 1;
  } else if (nextRepetitions === 2) {
    nextInterval = 6;
  } else {
    nextInterval = Math.round((card.intervalDays || 1) * nextEase);
  }

  return {
    easeFactor: nextEase,
    intervalDays: nextInterval,
    repetitions: nextRepetitions,
    dueDate: addDays(now, nextInterval)
  };
};

const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60 * 1000);

// ---------------------------------------------------------------------
// Shuffling — plain code, no AI involved.
// ---------------------------------------------------------------------

// Cryptographically-seeded Fisher-Yates shuffle. crypto.randomInt gives a
// stronger shuffle than Math.random for this purpose and is already
// available in Node with no extra dependency.
export const shuffle = (items) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

export const hashOrder = (ids) =>
  crypto.createHash("sha256").update(ids.join(",")).digest("hex");

/**
 * Shuffle `items` (by id) so the resulting order never matches
 * `previousHash` (the last order this user was given). Re-rolls a few
 * times on the astronomically rare collision, then accepts the result —
 * with 3+ cards a true infinite loop isn't a real risk.
 */
export const shuffleAvoidingRepeat = (items, previousHash) => {
  if (items.length <= 1) {
    const ids = items.map((item) => item.id);
    return { ordered: items, hash: hashOrder(ids) };
  }

  let ordered = items;
  let hash = previousHash;
  let attempts = 0;

  do {
    ordered = shuffle(items);
    hash = hashOrder(ordered.map((item) => item.id));
    attempts += 1;
  } while (hash === previousHash && attempts < 10);

  return { ordered, hash };
};
