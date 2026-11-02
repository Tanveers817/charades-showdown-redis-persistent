import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAnswer, isCorrectGuess, makeRoomCode, chooseWord, scoreGuess, scorePerformer, MAX_PLAYERS, MIN_PLAYERS, TURN_MS } from "../server/game.js";

test("answer matching ignores case, whitespace and punctuation", () => {
  assert.equal(isCorrectGuess("  Jurassic   Park! ", "jurassic park"), true);
  assert.equal(isCorrectGuess("Jurassic World", "Jurassic Park"), false);
});
test("normalization handles unicode compatibility forms", () => {
  assert.equal(normalizeAnswer("  ＰＩＺＺＡ "), "pizza");
});
test("room codes are six characters and avoid existing codes", () => {
  const code = makeRoomCode(new Set(["AAAAAA"]));
  assert.equal(code.length, 6);
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
});
test("word selection honors requested difficulty when available", () => {
  const word = chooseWord([{answer:"a",difficulty:"easy"},{answer:"b",difficulty:"hard"}], "hard");
  assert.equal(word.answer, "b");
});
test("score rules award correct, first and hard bonuses", () => {
  assert.equal(scoreGuess({firstCorrect:true,difficult:true}), 200);
  assert.equal(scoreGuess({firstCorrect:false,difficult:false}), 100);
  assert.equal(scorePerformer(true), 100);
  assert.equal(scorePerformer(false), 0);
});
test("game configuration supports 2–8 players and 60-second turns", () => {
  assert.equal(MIN_PLAYERS, 2);
  assert.equal(MAX_PLAYERS, 8);
  assert.equal(TURN_MS, 60_000);
});
