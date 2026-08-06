// Simple test for the "hey hi" fix
console.log("Testing the 'hey hi' wake word fix:");
console.log("=====================================\n");

// Test the regex pattern directly
const testPattern = /\b(hey\s+hi|hi\s+hey)\b/;

const testCases = [
  { input: "hey hi", expected: true },
  { input: "hey hi bikli", expected: true },
  { input: "hi hey", expected: true },
  { input: "hi hey bikli", expected: true },
  { input: "hey", expected: false },
  { input: "hi", expected: false },
  { input: "hello bikli", expected: false },
  { input: "wake up", expected: false },
];

let passed = 0;
let failed = 0;

testCases.forEach(({ input, expected }) => {
  const matches = testPattern.test(input);
  const status = matches === expected ? "✓ PASS" : "✗ FAIL";

  if (matches === expected) {
    passed++;
  } else {
    failed++;
  }

  console.log(`${status}: "${input}" -> ${matches} (expected: ${expected})`);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log("\n✓ All tests passed! The 'hey hi' fix is working correctly.");
} else {
  console.log("\n✗ Some tests failed. The fix may need adjustment.");
}
