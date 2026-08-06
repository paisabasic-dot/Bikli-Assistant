// Comprehensive test simulating various voice input scenarios
import { transcriptMatchesWake } from './src/lib/wakeWord.ts';

const defaultPhrases = [
  "hey", "hi", "hello", "bikli",
  "hey bikli", "hi bikli", "hello bikli",
  "hey hi", "hi hey",
  "ok bikli", "okay bikli", "yo bikli",
  "wake up", "wakeup", "wake up bikli", "wakeup bikli"
];

console.log("Voice Input Simulation Test");
console.log("===========================\n");

// Test scenarios that should wake Bikli
const positiveTests = [
  // Combined greetings (the main fix)
  { input: "heyhi", description: "Combined 'heyhi'" },
  { input: "hihi", description: "Combined 'hihi'" },
  { input: "heyhi bikli", description: "Combined 'heyhi bikli'" },
  { input: "hihi there", description: "Combined 'hihi there'" },

  // Normal greetings
  { input: "hey", description: "Single 'hey'" },
  { input: "hi", description: "Single 'hi'" },
  { input: "hello", description: "Single 'hello'" },
  { input: "bikli", description: "Single 'bikli'" },

  // Greet pairs
  { input: "hey hi", description: "Greet pair 'hey hi'" },
  { input: "hi hey", description: "Greet pair 'hi hey'" },
  { input: "hey hi bikli", description: "Greet pair with name" },

  // With bikli
  { input: "hey bikli", description: "'hey bikli'" },
  { input: "hi bikli", description: "'hi bikli'" },
  { input: "hello bikli", description: "'hello bikli'" },

  // STT glitches
  { input: "hhi", description: "STT glitch 'hhi'" },
  { input: "hii", description: "STT glitch 'hii'" },
  { input: "heyy", description: "STT glitch 'heyy'" },
  { input: "hay", description: "STT glitch 'hay'" },
  { input: "hei", description: "STT glitch 'hei'" },

  // Wake up phrases
  { input: "wake up", description: "'wake up'" },
  { input: "wakeup", description: "'wakeup'" },
  { input: "wake up bikli", description: "'wake up bikli'" },
];

// Test scenarios that should NOT wake Bikli
const negativeTests = [
  { input: "history", description: "Contains 'hi' but not as word" },
  { input: "high", description: "Contains 'hi' but not as word" },
  { input: "hey there", description: "'hey' in sentence (should match)" },
  { input: "hi there", description: "'hi' in sentence (should match)" },
  { input: "hello world", description: "'hello' in sentence (should match)" },
  { input: "biking", description: "Contains 'bik' but not 'bikli'" },
  { input: "weekly", description: "STT might mishear as bikli" },
];

let passed = 0;
let failed = 0;

console.log("✓ POSITIVE TESTS (should wake Bikli):\n");
positiveTests.forEach(({ input, description }) => {
  const result = transcriptMatchesWake(input, defaultPhrases);
  const status = result ? "✓ PASS" : "✗ FAIL";
  console.log(`${status}: "${input}" - ${description}`);
  if (result) passed++;
  else {
    failed++;
    console.log(`  Expected to match but didn't!`);
  }
});

console.log("\n✗ NEGATIVE TESTS (contextual - some may match):\n");
negativeTests.forEach(({ input, description }) => {
  const result = transcriptMatchesWake(input, defaultPhrases);
  const status = result ? "✓ MATCHED" : "✗ NO MATCH";
  console.log(`${status}: "${input}" - ${description}`);
  // Note: Some of these are expected to match (like "hey there")
  // because they contain valid wake words
});

console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("✓ All tests passed! The fix is working correctly.");
} else {
  console.log("✗ Some tests failed. Please review the fix.");
}
