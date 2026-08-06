# Fix Summary: heyhi and hihi Wake Word Detection

## Problem
The wake word detector was not recognizing combined greetings like "heyhi" and "hihi" because they were being treated as single words and didn't match the PRIMARY_GREETS patterns.

## Solution Implemented

### 1. Normalization Rules (lines 175-176 in `src/lib/wakeWord.ts`)
Added two new regex replacement rules to the `softNormalizeGreetGlitches` function:

```typescript
.replace(/\bheyhi\b/g, "hey hi") // heyhi → hey hi
.replace(/\bhihi\b/g, "hi hi");   // hihi → hi hi
```

These rules split the combined words into separate words, allowing the PRIMARY_GREETS check to match either "hey" or "hi".

### 2. Greet Pair Detection (lines 217-220 in `src/lib/wakeWord.ts`)
Added logic to explicitly check for "hey hi" and "hi hey" patterns:

```typescript
// 5b) Common greet pairs: "hey hi", "hi hey" — treat as single trigger
if (/\b(hey\s+hi|hi\s+hey)\b/.test(text) || /\b(hey\s+hi|hi\s+hey)\b/.test(raw)) {
  return true;
}
```

## Test Results

All test cases now pass:

- **"heyhi"** → normalized to **"hey hi"** → matches **"hey"** ✓
- **"hihi"** → normalized to **"hi hi"** → matches **"hi"** ✓
- **"hey hi"** → matches **"hey"** ✓
- **"hi hey"** → matches **"hey"** ✓

## Files Modified
- `src/lib/wakeWord.ts` - Added normalization rules and greet pair detection logic

## Verification
Run `node verify_fix.js` to see the fix in action.
