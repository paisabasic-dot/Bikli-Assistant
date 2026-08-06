// Test edge cases for the heyhi/hihi fix
import { transcriptMatchesWake } from './src/lib/wakeWord.ts';

const defaultPhrases = [
  "hey", "hi", "hello", "bikli",
  "hey bikli", "hi bikli", "hello bikli",
  "hey hi", "hi hey",
];

console.log("Edge Case Testing for heyhi/hihi Fix");
console.log("=====================================\n");

// Test the specific cases mentioned in the fix
const edgeCases = [
  // The main fix cases
  {
    input: "heyhi",
    expected: true,
    description: "heyhi should normalize to 'hey hi' and match 'hey'"
  },
  {
    input: "hihi",
    expected: true,
    description: "hihi should normalize to 'hi hi' and match 'hi'"
  },

  // Variations that should also work
  {
    input: "heyhi bikli",
    expected: true,
    description: "heyhi bikli should work"
  },
  {
    input: "hihi bikli",
    expected: true,
    description: "hihi bikli should work"
  },

  // Make sure we didn't break existing functionality
  {
    input: "hey hi",
    expected: true,
    description: "hey hi (separate words) should still work"
  },
  {
    input: "hi hey",
    expected: true,
    description: "hi hey (separate words) should still work"
  },
  {
    input: "hey hi bikli",
    expected: true,
    description: "hey hi bikli should still work"
  },

  // Edge cases with punctuation (should be stripped)
  {
    input: "heyhi!",
    expected: true,
    description: "heyhi with punctuation should work"
  },
  {
    input: "hihi?",
    expected: true,
    description: "hihi with punctuation should work"
  },

  // Mixed case
  {
    input: "HeyHi",
    expected: true,
    description: "HeyHi (mixed case) should work"
  },
  {
    input: "HiHi",
    expected: true,
    description: "HiHi (mixed case) should work"
  },

  // With extra spaces (should be normalized)
  {
    input: "hey  hi",
    expected: true,
    description: "hey  hi (double space) should work"
  },
  {
    input: "hi   hey",
    expected: true,
    description: "hi   hey (triple space) should work"
  },

  // Make sure similar but invalid patterns don't match
  {
    input: "heyhey",
    expected: true,  // This should match because 'heyhey' normalizes to 'hey hey'
    description: "heyhey should normalize to 'hey hey' and match"
  },
  {
    input: "hihi",
    expected: true,  // This should match because 'hihi' normalizes to 'hi hi'
    description: "hihi should normalize to 'hi hi' and match"
  },
];

let passed = 0;
let failed = 0;

edgeCases.forEach(({ input, expected, description }) => {
  const result = transcriptMatchesWake(input, defaultPhrases);
  const success = result === expected;

  if (success) {
    passed++;
    console.log(`✓ PASS: "${input}"`);
  } else {
    failed++;
    console.log(`✗ FAIL: "${input}"`);
  }
  console.log(`  ${description}`);
  console.log(`  Expected: ${expected}, Got: ${result}\n`);
});

console.log("=" .repeat(60));
console.log(`Results: ${passed}/${edgeCases.length} tests passed`);

if (failed === 0) {
  console.log("✓ All edge case tests passed!");
  console.log("\nThe fix correctly handles:");
  console.log("  • heyhi → hey hi (matches 'hey')");
  console.log("  • hihi → hi hi (matches 'hi')");
  console.log("  • Existing 'hey hi' and 'hi hey' patterns");
  console.log("  • Punctuation and case variations");
  console.log("  • Multiple spaces");
} else {
  console.log(`✗ ${failed} test(s) failed. Please review.`);
}
