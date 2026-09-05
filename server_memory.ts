import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import { Memory, MemoryTransaction } from "./src/lib/memoryTypes";
import { dataFile } from "./server_paths";

const MEMORY_FILE = dataFile("memories.json");

// Safe file operations with fallback
export async function loadMemories(): Promise<Memory[]> {
  try {
    const data = await fs.readFile(MEMORY_FILE, "utf-8");
    const parsed = JSON.parse(data);
    // A hand-edited / half-written file can parse to a non-array. Returning it
    // as-is makes every caller's .map/.filter throw instead of degrading.
    if (!Array.isArray(parsed)) {
      console.error("[Memory] memories.json is not an array — returning fallback.");
      return [];
    }
    return parsed as Memory[];
  } catch (error: any) {
    // If file doesn't exist, return empty array
    if (error.code === "ENOENT") {
      return [];
    }
    console.error("[Memory] Error loading memories, returning fallback:", error);
    return [];
  }
}

export async function saveMemories(memories: Memory[]): Promise<void> {
  try {
    await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
  } catch {}
  await fs.writeFile(MEMORY_FILE, JSON.stringify(memories, null, 2), "utf-8");
  console.log(`[Memory] Saved ${memories.length} memories successfully.`);
}

// ---------------------------------------------------------------------------
// Serialized memory writes.
//
// processConversationSlice (background), the "remember" tool, and the REST API
// all independently do load -> modify -> save. When they overlap, a slower
// writer can clobber a newer write and silently drop memories the user asked
// to persist. All mutations funnel through mutateMemories, which serializes
// load/modify/save so each writer starts from the latest on-disk state.
// ---------------------------------------------------------------------------
let memoryWriteChain: Promise<void> = Promise.resolve();

function enqueueMemoryWrite(task: () => Promise<void>): Promise<void> {
  const run = memoryWriteChain.then(task);
  // Swallow failures on the chain so one failed write does not block later ones.
  memoryWriteChain = run.catch(() => {});
  return run;
}

/**
 * Atomically read-modify-write memories under a single in-process lock.
 * `fn` receives the latest on-disk memories and returns the new list.
 * Resolves with the persisted list (throws if the write fails).
 */
export async function mutateMemories(
  fn: (memories: Memory[]) => Memory[] | Promise<Memory[]>,
): Promise<Memory[]> {
  let saved: Memory[] = [];
  await enqueueMemoryWrite(async () => {
    const current = await loadMemories();
    const next = await fn(current);
    if (!Array.isArray(next)) return;
    await saveMemories(next);
    saved = next;
  });
  return saved;
}

// Format memory core to system instruction injections
export function formatSystemInstructionsWithMemories(baseInstruction: string, memories: Memory[]): string {
  if (memories.length === 0) {
    return baseInstruction + 
      "\n\n" +
      "=== BIKLI MEMORY CORE ===\n" +
      "You do not possess any historic recollections of this companion yet. " +
      "As you speak, pay deep attention to who they are, their projects, relationships, and habits so you naturally grow closer over time.\n" +
      "=========================\n";
  }

  // Group by category
  const grouped: Record<string, string[]> = {};
  memories.forEach((m) => {
    grouped[m.category] = grouped[m.category] || [];
    grouped[m.category].push(m.text);
  });

  let memoryBlock = 
    "\n\n" +
    "=== BIKLI PERSISTENT MEMORY CORE (RECOLLECTIONS) ===\n" +
    "You have spoken with this user for a long duration. Below are your persistent recollections of who they are.\n" +
    "CRITICAL BRAND AND COGNITIVE PRINCIPLES:\n" +
    "- INTEGRATE MEMORIES INSTINCTIVELY: Always make conversational references feel completely smooth, natural, and human. NEVER say 'According to my memory files...', 'My recollection database indicates...', or 'As you told me on June 12th...'. Instead, speak of these details casually and supportively as a true friend would (e.g. 'Oh, since you're working on that website project...', 'I hope you're keeping up with your YouTube channel goals too!').\n" +
    "- COMPANIONSHIP DEPTH: Allow your witty and responsive personality to adapt with empathy, based on their goals, life events, emotional milestones, and preferences.\n\n" +
    "CURRENT PERSISTENT KNOWLEDGE CARD:\n";

  const categoriesOrdered = [
    { key: "identity", label: "Identity (Name, nick, profession, background)" },
    { key: "preference", label: "Preferences & Tastes (Likes, dislikes, games, movies)" },
    { key: "goal", label: "Active Goals & Aspirations" },
    { key: "project", label: "Ongoing Projects & Ecosystems" },
    { key: "relationship", label: "Key People & Relationships mentioned" },
    { key: "emotional", label: "Emotional Highlights & Core Milestones" },
    { key: "behavior", label: "Observed Traits & Behavioral Tendencies" },
  ];

  categoriesOrdered.forEach((cat) => {
    const list = grouped[cat.key] || [];
    if (list.length > 0) {
      memoryBlock += `* ${cat.label}:\n` + list.map(t => `  - ${t}`).join("\n") + "\n";
    }
  });

  memoryBlock += "====================================================\n";

  return baseInstruction + memoryBlock;
}

// Background memory consolidation queue lock & rate-limit cooldown
let isConsolidating = false;
let memoryCooldownUntil = 0;

const MEMORY_CANDIDATE_MODELS = [
  process.env.GEMINI_MEMORY_MODEL,
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash",
].filter(Boolean) as string[];

export async function processConversationSlice(
  apiKey: string,
  dialogueHistory: { role: string; text: string }[]
): Promise<Memory[] | null> {
  if (isConsolidating) {
    console.log("[Memory] Consolidation loop busy, skipping slice processing");
    return null;
  }

  if (Date.now() < memoryCooldownUntil) {
    return null;
  }

  if (dialogueHistory.length < 4) {
    return null;
  }

  isConsolidating = true;
  console.log("[Memory] Initiating pipeline for dialogue slice of length:", dialogueHistory.length);

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });

    // Snapshot for the prompt context (may be a moment stale — fine, it only
    // guides Gemini). The actual write below re-reads inside the lock.
    const contextMemories = await loadMemories();

    // Format memory map to help Gemini understand what to edit
    const memoryContext = contextMemories.map(m => `ID: ${m.id} | Category: ${m.category} | Fact: ${m.text}`).join("\n");
    const dialogueContext = dialogueHistory.map(line => `${line.role === "user" ? "User" : "Bikli"}: ${line.text}`).join("\n");

    const prompt = `You are Bikli's deep cognitive recollection engine. Your task is to analyze the recent conversation piece against previous persistent memories, and output precise update transactions.

### OBJECTIVE
Decide if any statements contain durable, important personal facts, enduring preferences, aspirations, ongoing projects, critical relationships, key historical emotional events, or behavioral trends.
Avoid cataloging small talk, greetings, general chit-chat, or fleeting sentences (e.g., ignore 'hello', 'how are you', 'waking up', 'lol').

### CURRENT USER MEMORIES:
${memoryContext || "(No memory records exist)"}

### RECENT DIALOGUE SLICE:
${dialogueContext}

### RULES
- ACTIONS:
  - "ADD": If new material information is introduced (e.g. user says 'My favorite food is lasagna' and it's not present).
  - "UPDATE": If previous information has evolved or is corrected (e.g. user says 'I changed my major to computer science' when memory says they study history). Provide the exact ID of the memory to replace.
  - "REMOVE": If a memory was explicitly disproven or the user directly asked Bikli to forget it.
- TEXT STYLE: Express the memories as clean, concise, third-person declarative summaries (e.g., 'The user is building a startup named Bikli.', 'The user loves playing GTA 6.', 'The user enjoys technical and fast-paced styling explanations.'). Do not include conversational filler, quotes, or timestamps.
- ID: For ADD, leave blank. For UPDATE or REMOVE, provide the exact 'id' from the "Current user memories" list.`;

    let response: any = null;
    let chosenModel = "";

    for (const modelName of MEMORY_CANDIDATE_MODELS) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                transactions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "ADD, UPDATE, or REMOVE transaction.",
                        enum: ["ADD", "UPDATE", "REMOVE"]
                      },
                      id: {
                        type: Type.STRING,
                        description: "Specific ID of the existing memory being modified or deleted (leave blank/null for ADD)."
                      },
                      category: {
                        type: Type.STRING,
                        description: "The Memory category classification.",
                        enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
                      },
                      text: {
                        type: Type.STRING,
                        description: "The memory summarized as a concise declarative statement in third-person."
                      }
                    },
                    required: ["action", "category", "text"]
                  }
                }
              },
              required: ["transactions"]
            }
          }
        });
        chosenModel = modelName;
        break;
      } catch (modelErr: any) {
        const msg = String(modelErr?.message || modelErr);
        const isQuota = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded");
        if (isQuota) {
          memoryCooldownUntil = Date.now() + 120_000;
          console.warn(`[Memory] Gemini quota reached (${modelName}). Pausing background consolidation for 2 minutes to protect voice chat.`);
          return null;
        }
        // If 404 or 503, try next candidate model
        continue;
      }
    }

    if (!response || !response.text) {
      return null;
    }

    const resultText = (response.text?.trim()) || "{}";
    const resultObj = JSON.parse(resultText);
    const transactions: MemoryTransaction[] = resultObj.transactions || [];

    if (transactions.length === 0) {
      console.log("[Memory] Zero transactions generated. Ignored routine conversations.");
      return null;
    }

    console.log(`[Memory] Processing ${transactions.length} memory updates:`, JSON.stringify(transactions));

    // Apply transactions under the serialized write lock so a concurrent
    // "remember" / REST write cannot be overwritten by this slower snapshot.
    const updatedMemories = await mutateMemories(async (latest) => {
      const timestamp = new Date().toISOString();
      const working = [...latest];
      const removedIds = new Set<string>();

      for (const trx of transactions) {
        if (trx.action === "REMOVE") {
          removedIds.add(trx.id);
        } else if (trx.action === "ADD") {
          const newMemory: Memory = {
            id: randomUUID().slice(0, 9),
            category: trx.category,
            text: trx.text,
            createdAt: timestamp,
            updatedAt: timestamp
          };
          working.push(newMemory);
        } else if (trx.action === "UPDATE") {
          const tarIndex = working.findIndex(m => m.id === trx.id);
          if (tarIndex !== -1) {
            working[tarIndex] = {
              ...working[tarIndex],
              category: trx.category,
              text: trx.text,
              updatedAt: timestamp
            };
          } else {
            // Fallback, treat as ADD if ID not matched
            const newMemory: Memory = {
              id: randomUUID().slice(0, 9),
              category: trx.category,
              text: trx.text,
              createdAt: timestamp,
              updatedAt: timestamp
            };
            working.push(newMemory);
          }
        }
      }
      return working.filter(m => !removedIds.has(m.id));
    });

    return updatedMemories;

  } catch (error) {
    console.error("[Memory] Consolidation failure:", error);
    return null;
  } finally {
    isConsolidating = false;
  }
}
