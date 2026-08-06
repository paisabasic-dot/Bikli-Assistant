// Test the "hey hi" fix using ES modules
import { transcriptMatchesWake } from './src/lib/wakeWord.ts';

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
    .replace(/\bhei\b/g, "hey")
    .replace(/\bheyhi\b/g, "hey hi")
    .replace(/\bhihi\b/g, "hi hi");
}

// Test cases
const testCases = [
  "heyhi",
  "hihi",
  "hey hi",
  "hey hi bikli",
  "hi hey",
  "hi hey bikli",
  "hey",
  "hi",
  "hello",
  "bikli"
];

console.log("Testing wake word detection with fix:");
console.log("======================================\n");

const defaultPhrases = ["hey", "hi", "hello", "bikli", "hey bikli", "hi bikli", "hello bikli", "hey hi", "hi hey", "ok bikli", "okay bikli", "yo bikli", "wake up", "wakeup", "wake up bikli", "wakeup bikli"];

testCases.forEach(phrase => {
  const raw = normalizeTranscript(phrase);
  const text = softNormalizeGreetGlitches(raw);
  const matches = transcriptMatchesWake(phrase, defaultPhrases);

  console.log(`"${phrase}"`);
  console.log(`  raw: "${raw}"`);
  console.log(`  text: "${text}"`);
  console.log(`  matches: ${matches ? '✓ YES' : '✗ NO'}`);
  console.log();
});
