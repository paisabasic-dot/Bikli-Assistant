/**
 * DEPRECATED — This file imported a Vite build artifact with a hardcoded hash.
 * Use test_edge_cases.mjs (npx tsx test_edge_cases.mjs) instead, which imports
 * directly from the TypeScript source.
 *
 * Keeping as a standalone pattern test:
 */

// Standalone regex test for "hey hi" / "hi hey" pattern matching

// Mock the functions that are used
function normalizeTranscript(transcript) {
  return transcript
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\bwakeup\b/g, "wake up")
    .replace(/\s+/g, " ")
    .trim();
}

function softNormalizeGreetGlitches(text) {
  return text
    .replace(/\bh{2,}i+\b/g, "hi")
    .replace(/\bhe+y+\b/g, "hey")
    .replace(/\bhay\b/g, "hey")
    .replace(/\bhei\b/g, "hey");
}

// Test cases
const testCases = [
  "hey hi",
  "hey hi bikli",
  "hi hey",
  "hi hey bikli",
  "hey",
  "hi",
  "hello",
  "bikli"
];

console.log("Testing wake word detection:");
console.log("================================");

testCases.forEach(phrase => {
  const raw = normalizeTranscript(phrase);
  const text = softNormalizeGreetGlitches(raw);

  // Check if it matches the new regex
  const matchesPair = /\b(hey\s+hi|hi\s+hey)\b/.test(text) || /\b(hey\s+hi|hi\s+hey)\b/.test(raw);

  console.log(`"${phrase}" -> raw: "${raw}", text: "${text}", matches pair: ${matchesPair}`);
});
