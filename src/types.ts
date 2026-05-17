import { z } from "zod";

export interface DomainProfile {
  boost?: string[];
  block?: string[];
}

export interface DomainConfig {
  boost: string[];
  block: string[];
  profiles: Record<string, DomainProfile>;
}

export interface SearxResult {
  title: string;
  url: string;
  content?: string;
  /** @deprecated Use `engines` instead */
  engine?: string;
  engines?: string[];
  publishedDate?: string;
}

export interface SearxResponse {
  results: SearxResult[];
}

export interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      sourceURL?: string;
    };
  };
  error?: string;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
}

export interface RerankResponse {
  results: RerankResult[];
}

export interface OpenAIChatChoice {
  index: number;
  message: {
    role: string;
    content: string;
  };
  finish_reason: string;
}

export interface OpenAIChatResponse {
  choices: OpenAIChatChoice[];
}

export interface Citation {
  url: string;
  title: string;
  key_facts: string[];
}

export interface SummaryResult {
  summary: string;
  citations: Citation[];
}

export interface GitHubReadmeResponse {
  content: string;
  name: string;
  html_url: string;
}

export interface GitHubIssueResponse {
  title: string;
  body: string;
  html_url: string;
  state: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  comments: number;
  reactions?: {
    "+1": number;
    "-1": number;
    laugh: number;
    hooray: number;
    confused: number;
    heart: number;
    rocket: number;
    eyes: number;
  };
}

export interface GitHubCommentResponse {
  body: string;
  html_url: string;
  user: { login: string };
  created_at: string;
  reactions?: {
    "+1": number;
    "-1": number;
    laugh: number;
    hooray: number;
    confused: number;
    heart: number;
    rocket: number;
    eyes: number;
  };
}

export const CitationSchema = z.object({
  url: z.string(),
  title: z.string(),
  key_facts: z.array(z.string()).default([]),
});

export const SummarySchema = z.object({
  summary: z.string().default(""),
  citations: z.array(CitationSchema).default([]),
});

export const CategorySchema = z
  .enum([
    "general",
    "news",
    "it",
    "science",
    "images",
    "videos",
    "files",
    "social media",
  ])
  .default("general");

export const TimeRangeSchema = z
  .enum(["day", "week", "month", "year"])
  .optional();
