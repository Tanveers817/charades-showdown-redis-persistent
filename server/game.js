export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
export const TURN_MS = 60_000;
export const MAX_PASSES = 2;

export const WORDS = [
  { answer: "Kangaroo", category: "Animals", difficulty: "easy" },
  { answer: "Toothbrush", category: "Objects", difficulty: "easy" },
  { answer: "Basketball", category: "Sports", difficulty: "easy" },
  { answer: "Brushing your teeth", category: "Actions", difficulty: "easy" },
  { answer: "Pizza", category: "Food", difficulty: "easy" },
  { answer: "Firefighter", category: "Professions", difficulty: "medium" },
  { answer: "Jurassic Park", category: "Movies", difficulty: "medium" },
  { answer: "Playing the drums", category: "Actions", difficulty: "medium" },
  { answer: "Roller coaster", category: "Objects", difficulty: "medium" },
  { answer: "Superhero", category: "Famous characters", difficulty: "medium" },
  { answer: "Walking on the moon", category: "Actions", difficulty: "hard" },
  { answer: "The invisible man", category: "Movies", difficulty: "hard" },
  { answer: "Synchronized swimming", category: "Sports", difficulty: "hard" },
  { answer: "Breaking the ice", category: "Actions", difficulty: "hard" }
];

export function normalizeAnswer(value = "") {
  return String(value).normalize("NFKC").toLocaleLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

export function isCorrectGuess(guess, answer) {
  return normalizeAnswer(guess) === normalizeAnswer(answer);
}

export function makeRoomCode(existingCodes = new Set()) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!existingCodes.has(code)) return code;
  }
  throw new Error("Unable to allocate a room code");
}

export function chooseWord(words = WORDS, difficulty = "mixed", used = new Set()) {
  let pool = words.filter(w => !used.has(w.answer));
  if (!pool.length) pool = words;
  if (difficulty !== "mixed") {
    const matching = pool.filter(w => w.difficulty === difficulty);
    if (matching.length) pool = matching;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

export function scoreGuess({ firstCorrect, difficult }) {
  return 100 + (firstCorrect ? 50 : 0) + (difficult ? 50 : 0);
}

export function scorePerformer(anyCorrect) {
  return anyCorrect ? 100 : 0;
}

export function createPlayer(id, name, avatar) {
  return { id, name: name.trim().slice(0, 18), avatar: avatar || "🎭", score: 0, correctGuesses: 0, firstGuesses: 0, performerPoints: 0, connected: true, ready: false };
}
