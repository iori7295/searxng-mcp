import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { CHUNK_MAX_SIZE } from "./config.js";

export interface TextChunk {
  text: string;
  sourceIndex: number;
  chunkIndex: number;
}

export async function chunkPages(
  pages: Array<{ title: string; url: string; text: string }>,
  maxSize = CHUNK_MAX_SIZE,
  overlap = 100,
): Promise<TextChunk[]> {
  const s = new RecursiveCharacterTextSplitter({
    chunkSize: maxSize,
    chunkOverlap: overlap,
    separators: ["\n\n", "\n", "。", ". ", " ", ""],
  });

  const allChunks: TextChunk[] = [];
  for (let i = 0; i < pages.length; i++) {
    const rawChunks = pages[i].text ? await s.splitText(pages[i].text) : [""];
    for (let j = 0; j < rawChunks.length; j++) {
      allChunks.push({ text: rawChunks[j], sourceIndex: i, chunkIndex: j });
    }
  }
  return allChunks;
}
